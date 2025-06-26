let Module = {};
((function () {
    "use strict";
    let VINT_SIZES = [0, 8, 7, 7, 6, 6, 6, 6, 5, 5, 5, 5, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
    let VINT_MASKS = [255, 127, 63, 31, 15, 7, 3, 1, 0];
    let OPUS_SIG = [65, 95, 79, 80, 85, 83];

    let _decoder = null;
    let _audioBuffer = null;
    let _inputPointer = null;
    let _outputBuffer = null;
    let _outputPointer = null;
    let _outputOffset = 0;

    // Ready promise resolves when onRuntimeInitialized called
    let readyPromiseResolve = null;
    const readyPromise = new Promise(resolve => readyPromiseResolve = resolve);

    Module = {
        // When WASM has finished loading, resolve the ready promise
        onRuntimeInitialized: readyPromiseResolve
    };

    function ReadVInt(data, position, length, initialMask) {
        let value = data.getUint8(position) & initialMask;
        for (let i = 1; i < length; i++) value = (value << 8) + data.getUint8(position + i);
        return value
    }

    function ParseIntTag(data, position, size) {
        switch (size) {
            case 1:
                return data.getInt8(position);
            case 2:
                return data.getInt16(position);
            case 3:
                return ReadInt24(data, position);
            case 4:
                return data.getInt32(position);
            default:
                throw new Error("Invalid size");
        }
    }

    function ReadInt24(data, position) {
        let first = data.getInt8(position);
        let sign = first >> 7;
        let value = first & 0b1111111;

        value = (value << 8) | data.getUint8(position);
        value = (value << 8) | data.getUint8(position);

        return sign === 1 ? -value : value;
    }

    function CalculateAudioBufferSize(rate, channels, duration) {
        return rate / 1e3 * channels * duration
    }

    function CreateDecoder(duration) {
        let frequency = 48e3;
        let channels = 1;
        let bufferSize = 2048;
        // the true size should be "duration - codecDelay"
        // but we also write the "discardpadding" at the end 
        // of the buffer before discarding it, so we need 1 opus frame of
        // extra space. max size of a frame is 120ms
        let length = CalculateAudioBufferSize(frequency, channels, duration + 120);
        _audioBuffer = new Float32Array(length);
        if (!_outputBuffer) {
            _outputPointer = Module._malloc(bufferSize << 2);
            _outputBuffer = new Float32Array(Module.HEAPU8.buffer, _outputPointer, bufferSize)
        }
        if (!_inputPointer) {
            _inputPointer = Module._malloc(bufferSize)
        }
        _decoder = Module._create_decoder(frequency, channels);
        if (_decoder < 0) throw new Error("Failed to create decoder")
    }

    function DestroyDecoder() {
        Module._destroy_decoder(_decoder);
        _decoder = null;
        _outputOffset = 0;
    }

    /////////////////////////////////////////////////////////
    // Main job handler
    self.JobHandlers["OpusDecode"] = async function OpusDecode(params) {
        // Wait for WASM to finish loading if necessary
        await readyPromise;

        // Decode the Opus compressed audio to a float sample buffer and return the ArrayBuffer
        const arrayBuffer = params["arrayBuffer"];
        ParseMaster(new DataView(arrayBuffer), 0, arrayBuffer.byteLength);
        const end = _outputOffset;
        DestroyDecoder();
        const outputBuffer = _audioBuffer.buffer.slice(0, end * 4);
        _audioBuffer = null;
        return {
            result: outputBuffer,
            transferables: [outputBuffer]
        };
    };

    function WriteOutput(ret) {
        if (ret + _outputOffset > 0) {
            let tempBuffer;
            let writePosition = _outputOffset;
            if (_outputOffset < 0) {
                let trim = -_outputOffset;
                tempBuffer = new Float32Array(Module.HEAPU8.buffer, _outputPointer + trim * 4, ret - trim);
                writePosition = 0;
            }
            else {
                tempBuffer = new Float32Array(Module.HEAPU8.buffer, _outputPointer, ret);
            }

            if (writePosition + tempBuffer.length > _audioBuffer.length)
                throw new Error("Buffer overflow");

            _audioBuffer.set(tempBuffer, writePosition);
        }

        _outputOffset += ret;
    }

    function ParseFrame(data) {
        let length = data.length;
        Module.HEAPU8.set(data, _inputPointer);
        let ret = Module._decode_frame(_decoder, _inputPointer, length, _outputPointer, 4096);
        if (ret > 0) {
            WriteOutput(ret);
        } else {
            throw new Error("Failed to parse frame")
        }
    }

    function ParseBlock(data, position, size) {
        let firstByte, tagLength, flags, lacing;
        firstByte = data.getUint8(position);
        tagLength = VINT_SIZES[firstByte];
        position += tagLength;
        position += 2;
        flags = data.getUint8(position);
        position += 1;
        size -= tagLength + 3;
        lacing = flags & 6;
        if (lacing) throw new Error("Lacing not supported");
        ParseFrame(new Uint8Array(data.buffer, position, size))
    }

    function ParseDuration(data, position, size) {
        let duration;
        if (size == 4) duration = data.getFloat32(position);
        else if (size == 8) duration = data.getFloat64(position);
        else throw new Error("Invalid size");
        CreateDecoder(duration)
    }

    function ParseDiscard(data, position, size) {
        // NOTE discard in an integer
        // postive values are trailing, negative are leading
        // value is in nanoseconds
        let discardDuration = ParseIntTag(data, position, size);
        if (discardDuration < 0)
            throw new Error("Cannot discard leading block data");
        let discardFrames = Math.floor(discardDuration * 0.000048);
        _outputOffset -= discardFrames;
    }

    function ParseDelay(data, position, size) {
        let discardDuration = ReadVInt(data, position, size, 0xFF);
        _outputOffset = -Math.floor(discardDuration * 0.000048)
    }

    function TestOpus(data, position) {
        for (let i = 0, l = 6; i < l; i++) {
            if (data.getUint8(position + i) != OPUS_SIG[i]) throw new Error("Contains non opus data")
        }
    }

    function ParseMaster(data, position, length) {
        let firstByte, tagLength, id, sizeLength, mask, size;
        let end = position + length;
        while (position < end) {
            firstByte = data.getUint8(position);
            tagLength = VINT_SIZES[firstByte];
            if (tagLength > 4 || tagLength == 0) throw new Error("Invalid tag length " + tagLength);
            id = ReadVInt(data, position, tagLength, 255);
            position += tagLength;
            firstByte = data.getUint8(position);
            sizeLength = VINT_SIZES[firstByte];
            mask = VINT_MASKS[sizeLength];
            if (sizeLength == 0) throw new Error("Invalid size length");
            size = ReadVInt(data, position, sizeLength, mask);
            position += sizeLength;
            switch (id) {
                case 408125543: // Segment
                case 357149030: // Info
                case 524531317: // Cluster
                case 374648427: // Tracks
                case 174:       // TrackEntry
                case 160:       // BlockGroup
                    ParseMaster(data, position, size);
                    break;
                case 17545:     // Duration
                    ParseDuration(data, position, size);
                    break;
                case 22186:     // CodecDelay
                    ParseDelay(data, position, size);
                    break;
                case 30114:     // DiscardPadding
                    ParseDiscard(data, position, size);
                    break;
                case 134:       // CodecID
                    TestOpus(data, position);
                    break;
                case 161:       // Block
                case 163:       // SimpleBlock
                    ParseBlock(data, position, size);
                    break;
            }
            position += size
        }
    }
}))();// Using an object to hold functions
// Using an object to hold functions


if (!Module) Module = (typeof Module !== "undefined" ? Module : null) || {};
/* eslint-enable no-var */
let moduleOverrides = {};
for (let key in Module) {
    if (Module.hasOwnProperty(key)) {
        moduleOverrides[key] = Module[key]
    }
}
let ENVIRONMENT_IS_WEB = false;
let ENVIRONMENT_IS_WORKER = false;
let ENVIRONMENT_IS_NODE = false;
let ENVIRONMENT_IS_SHELL = false;
if (Module["ENVIRONMENT"]) {
    if (Module["ENVIRONMENT"] === "WEB") {
        ENVIRONMENT_IS_WEB = true
    } else if (Module["ENVIRONMENT"] === "WORKER") {
        ENVIRONMENT_IS_WORKER = true
    } else if (Module["ENVIRONMENT"] === "NODE") {
        ENVIRONMENT_IS_NODE = true
    } else if (Module["ENVIRONMENT"] === "SHELL") {
        ENVIRONMENT_IS_SHELL = true
    } else {
        throw new Error("The provided Module['ENVIRONMENT'] value is not valid. It must be one of: WEB|WORKER|NODE|SHELL.")
    }
} else {
    ENVIRONMENT_IS_WEB = typeof window === "object";
    ENVIRONMENT_IS_WORKER = typeof importScripts === "function";
    ENVIRONMENT_IS_NODE = typeof process === "object" && typeof require === "function" && !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER;
    ENVIRONMENT_IS_SHELL = !ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_NODE && !ENVIRONMENT_IS_WORKER
}
if (ENVIRONMENT_IS_NODE) {
    if (!Module["print"]) Module["print"] = console.log;
    if (!Module["printErr"]) Module["printErr"] = console.warn;
    let nodeFS;
    let nodePath;
    Module["read"] = function shell_read(filename, binary) {
        if (!nodeFS) nodeFS = require("fs");
        if (!nodePath) nodePath = require("path");
        filename = nodePath["normalize"](filename);
        let ret = nodeFS["readFileSync"](filename);
        return binary ? ret : ret.toString()
    };
    Module["readBinary"] = function readBinary(filename) {
        let ret = Module["read"](filename, true);
        if (!ret.buffer) {
            ret = new Uint8Array(ret)
        }
        assert(ret.buffer);
        return ret
    };
    Module["load"] = function load(f) {
        read(f)
    };
    if (!Module["thisProgram"]) {
        if (process["argv"].length > 1) {
            Module["thisProgram"] = process["argv"][1].replace(/\\/g, "/")
        } else {
            Module["thisProgram"] = "unknown-program"
        }
    }
    Module["arguments"] = process["argv"].slice(2);
    if (typeof module !== "undefined") {
        module["exports"] = Module
    }
    process["on"]("uncaughtException", (function (ex) {
        if (!(ex instanceof ExitStatus)) {
            throw new Error(ex)
        }
    }));
    Module["inspect"] = (function () {
        return "[Emscripten Module object]"
    })
} else if (ENVIRONMENT_IS_SHELL) {
    if (!Module["print"]) Module["print"] = print;
    if (typeof printErr != "undefined") Module["printErr"] = printErr;
    if (typeof read != "undefined") {
        Module["read"] = read
    } else {
        Module["read"] = function shell_read() {
            throw new Error("no read() available")
        }
    }
    Module["readBinary"] = function readBinary(f) {
        if (typeof readbuffer === "function") {
            return new Uint8Array(readbuffer(f))
        }
        let data = read(f, "binary");
        assert(typeof data === "object");
        return data
    };
    if (typeof scriptArgs != "undefined") {
        Module["arguments"] = scriptArgs
    } else if (typeof arguments != "undefined") {
        Module["arguments"] = arguments
    }
    if (typeof quit === "function") {
        Module["quit"] = (function (status, toThrow) {
            quit(status)
        })
    }
} else if (ENVIRONMENT_IS_WEB || ENVIRONMENT_IS_WORKER) {
    Module["read"] = function shell_read(url) {
        let xhr = new XMLHttpRequest;
        xhr.open("GET", url, false);
        xhr.send(null);
        return xhr.responseText
    };
    if (ENVIRONMENT_IS_WORKER) {
        Module["readBinary"] = function readBinary(url) {
            let xhr = new XMLHttpRequest;
            xhr.open("GET", url, false);
            xhr.responseType = "arraybuffer";
            xhr.send(null);
            return new Uint8Array(xhr.response)
        }
    }
    Module["readAsync"] = function readAsync(url, onload, onerror) {
        let xhr = new XMLHttpRequest;
        xhr.open("GET", url, true);
        xhr.responseType = "arraybuffer";
        xhr.onload = function xhr_onload() {
            if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
                onload(xhr.response)
            } else {
                onerror()
            }
        };
        xhr.onerror = onerror;
        xhr.send(null)
    };
    if (typeof arguments != "undefined") {
        Module["arguments"] = arguments
    }
    if (typeof console !== "undefined") {
        if (!Module["print"]) Module["print"] = function shell_print(x) {
            console.log(x)
        };
        if (!Module["printErr"]) Module["printErr"] = function shell_printErr(x) {
            console.warn(x)
        }
    } else {
        let TRY_USE_DUMP = false;
        if (!Module["print"]) Module["print"] = TRY_USE_DUMP && typeof dump !== "undefined" ? (function (x) {
            dump(x)
        }) : (function (x) { })
    }
    if (ENVIRONMENT_IS_WORKER) {
        Module["load"] = importScripts
    }
    if (typeof Module["setWindowTitle"] === "undefined") {
        Module["setWindowTitle"] = (function (title) {
            document.title = title
        })
    }
} else {
    throw new Error("Unknown runtime environment. Where are we?")
}



if (!Module["load"] && Module["read"]) {
    Module["load"] = function load(f) {
        Module["read"](f)
    }
}
if (!Module["print"]) {
    Module["print"] = (function () { })
}
if (!Module["printErr"]) {
    Module["printErr"] = Module["print"]
}
if (!Module["arguments"]) {
    Module["arguments"] = []
}
if (!Module["thisProgram"]) {
    Module["thisProgram"] = "./this.program"
}
if (!Module["quit"]) {
    Module["quit"] = (function (status, toThrow) {
        throw new Error(toThrow)
    })
}
Module.print = Module["print"] || console.log;
Module.printErr = Module["printErr"] || console.log;
Module["preRun"] = [];
Module["postRun"] = [];
for (let key in moduleOverrides) {
    if (moduleOverrides.hasOwnProperty(key)) {
        Module[key] = moduleOverrides[key]
    }
}


let tempRet0;
moduleOverrides = undefined;
let Runtime = {
    setTempRet0: (function (value) {
        tempRet0 = value;
        return value
    }),
    getTempRet0: (function () {
        return tempRet0
    }),
    stackSave: (function () {
        return STACKTOP
    }),
    stackRestore: (function (stackTop) {
        STACKTOP = stackTop
    }),
    getNativeTypeSize: (function (type) {
        switch (type) {
            case "i1":
            case "i8":
                return 1;
            case "i16":
                return 2;
            case "i32":
                return 4;
            case "i64":
                return 8;
            case "float":
                return 4;
            case "double":
                return 8;
            default:
                {
                    if (type[type.length - 1] === "*") {
                        return Runtime.QUANTUM_SIZE
                    } else if (type[0] === "i") {
                        let bits = parseInt(type.substr(1));
                        assert(bits % 8 === 0);
                        return bits / 8
                    } else {
                        return 0
                    }
                }
        }
    }),
    getNativeFieldSize: (function (type) {
        return Math.max(Runtime.getNativeTypeSize(type), Runtime.QUANTUM_SIZE)
    }),
    STACK_ALIGN: 16,
    prepVararg: (function (ptr, type) {
        if (type === "double" || type === "i64") {
            if (ptr & 7) {
                assert((ptr & 7) === 4);
                ptr += 4
            }
        } else {
            assert((ptr & 3) === 0)
        }
        return ptr
    }),
    getAlignSize: (function (type, size, vararg) {
        if (!vararg && (type == "i64" || type == "double")) return 8;
        if (!type) return Math.min(size, 8);
        return Math.min(size || (type ? Runtime.getNativeFieldSize(type) : 0), Runtime.QUANTUM_SIZE)
    }),
    dynCall: (function (sig, ptr, args) {
        if (args?.length) {
            return Module["dynCall_" + sig].apply(null, [ptr].concat(args))
        } else {
            return Module["dynCall_" + sig].call(null, ptr)
        }
    }),
    functionPointers: [],
    addFunction: (function (func) {
        for (let i = 0; i < Runtime.functionPointers.length; i++) {
            if (!Runtime.functionPointers[i]) {
                Runtime.functionPointers[i] = func;
                return 2 * (1 + i)
            }
        }
        throw new Error("Finished up all reserved function pointers. Use a higher value for RESERVED_FUNCTION_POINTERS.")
    }),
    removeFunction: (function (index) {
        Runtime.functionPointers[(index - 2) / 2] = null
    }),
    warnOnce: (function (text) {
        if (!Runtime.warnOnce.shown) Runtime.warnOnce.shown = {};
        if (!Runtime.warnOnce.shown[text]) {
            Runtime.warnOnce.shown[text] = 1;
            Module.printErr(text)
        }
    }),
    funcWrappers: {},
    getFuncWrapper: (function (func, sig) {
        assert(sig);
        if (!Runtime.funcWrappers[sig]) {
            Runtime.funcWrappers[sig] = {}
        }
        let sigCache = Runtime.funcWrappers[sig];
        if (!sigCache[func]) {
            if (sig.length === 1) {
                sigCache[func] = function dynCall_wrapper() {
                    return Runtime.dynCall(sig, func)
                }
            } else if (sig.length === 2) {
                sigCache[func] = function dynCall_wrapper(arg) {
                    return Runtime.dynCall(sig, func, [arg])
                }
            } else {
                sigCache[func] = function dynCall_wrapper() {
                    return Runtime.dynCall(sig, func, Array.prototype.slice.call(arguments))
                }
            }
        }
        return sigCache[func]
    }),
    getCompilerSetting: (function (name) {
        throw new Error("You must build with -s RETAIN_COMPILER_SETTINGS=1 for Runtime.getCompilerSetting or emscripten_get_compiler_setting to work")
    }),
    stackAlloc: (function (size) {
        let ret = STACKTOP;
        STACKTOP = STACKTOP + size | 0;
        STACKTOP = STACKTOP + 15 & -16;
        return ret
    }),
    staticAlloc: (function (size) {
        let ret = STATICTOP;
        STATICTOP = STATICTOP + size | 0;
        STATICTOP = STATICTOP + 15 & -16;
        return ret
    }),
    dynamicAlloc: (function (size) {
        let ret = HEAP32[DYNAMICTOP_PTR >> 2];
        let end = (ret + size + 15 | 0) & -16;
        HEAP32[DYNAMICTOP_PTR >> 2] = end;
        if (end >= TOTAL_MEMORY) {
            let success = enlargeMemory();
            if (!success) {
                HEAP32[DYNAMICTOP_PTR >> 2] = ret;
                return 0
            }
        }
        return ret
    }),
    alignMemory: (function (size, quantum = 16) {
        let ret = Math.ceil(size / quantum) * quantum;
        return ret
    }),
    makeBigInt: (function (low, high, unsigned) {
        let ret = unsigned ? +(low >>> 0) + +(high >>> 0) * 4294967296 : +(low >>> 0) + +(high | 0) * 4294967296;
        return ret
    }),
    GLOBAL_BASE: 1024,
    QUANTUM_SIZE: 4,
    __dummy__: 0
};
Module["Runtime"] = Runtime;
let ABORT = 0;
let EXITSTATUS = 0;

function assert(condition, text) {
    if (!condition) {
        abort("Assertion failed: " + text)
    }
}

function getCFunc(ident) {
    // Look for the function in the Module object with a prepended underscore
    let func = Module["_" + ident];

    // If the function is not found in the Module object
    if (!func) {
        // Dynamically search for the function in the global scope
        func = window["_" + ident];  // This is safer than eval()
    }

    // Assert that the function exists
    assert(func, "Cannot call unknown function " + ident + " (perhaps LLVM optimizations or closure removed it?)");

    return func;
}

let cwrap, ccall;
((function () {
    let JSfuncs = {
        "stackSave": (function () {
            Runtime.stackSave()
        }),
        "stackRestore": (function () {
            Runtime.stackRestore()
        }),
        "arrayToC": (function (arr) {
            let ret = Runtime.stackAlloc(arr.length);
            writeArrayToMemory(arr, ret);
            return ret
        }),
        "stringToC": (function (str) {
            let ret = 0;
            if (str !== null && str !== undefined && str !== 0) {
                let len = (str.length << 2) + 1;
                ret = Runtime.stackAlloc(len);
                stringToUTF8(str, ret, len)
            }
            return ret
        })
    };
    let toC = {
        "string": JSfuncs["stringToC"],
        "array": JSfuncs["arrayToC"]
    };
    ccall = function ccallFunc(ident, returnType, argTypes, args, opts) {
        let func = getCFunc(ident);
        let cArgs = [];
        let stack = 0;
        if (args) {
            for (let i = 0; i < args.length; i++) {
                let converter = toC[argTypes[i]];
                if (converter) {
                    if (stack === 0) stack = Runtime.stackSave();
                    cArgs[i] = converter(args[i])
                } else {
                    cArgs[i] = args[i]
                }
            }
        }
        let ret = func(...cArgs);

        if (returnType === "string") ret = Pointer_stringify(ret);
        if (stack !== 0) {
            if (opts?.async) {
                EmterpreterAsync.asyncFinalizers.push((function () {
                    Runtime.stackRestore(stack)
                }));
                return
            }
            Runtime.stackRestore(stack)
        }
        return ret
    };
    let sourceRegex = /^function\s+[a-zA-Z$_][a-zA-Z$_0-9]*\s*\(([a-zA-Z0-9$_,\s]*)\)\s*{([\s\S]*?)}?$/;

    function parseJSFunc(jsfunc) {
        let parsed = jsfunc.toString().match(sourceRegex).slice(1);
        return {
            arguments: parsed[0],
            body: parsed[1],
            returnValue: parsed[2]
        }
    }
    let JSsource = null;

    function ensureJSsource() {
        if (!JSsource) {
            JSsource = {};
            for (let fun in JSfuncs) {
                if (JSfuncs.hasOwnProperty(fun)) {
                    JSsource[fun] = parseJSFunc(JSfuncs[fun])
                }
            }
        }
    }
    cwrap = function cwrap(ident, returnType, argTypes) {
        argTypes = argTypes || [];

        // Get the C function based on the identifier
        let cfunc = getCFunc(ident);
        let numericArgs = argTypes.every(type => type === "number");
        let numericRet = returnType !== "string";

        // If all arguments are numeric and return type is not a string, return the C function directly
        if (numericRet && numericArgs) {
            return cfunc;
        }

        // Define a wrapper function that will handle argument conversion and calling the C function
        return function (...args) {
            if (args.length !== argTypes.length) {
                throw new Error("Incorrect number of arguments");
            }

            let convertedArgs = [];

            // Convert each argument based on its expected type
            for (let i = 0; i < argTypes.length; i++) {
                let arg = args[i];
                let expectedType = argTypes[i];

                if (expectedType === "number") {
                    if (typeof arg !== "number") {
                        throw new Error(`Argument ${i} is expected to be a number`);
                    }
                    convertedArgs.push(arg);  // No conversion needed for numbers
                } else if (expectedType === "string") {
                    ensureJSsource();
                    let convertCode = JSsource["stringToC"];
                    let converted = convertCode(arg);  // Convert string to C-compatible format
                    convertedArgs.push(converted);
                } else {
                    throw new Error(`Unsupported argument type: ${expectedType}`);
                }
            }

            // Call the C function with the converted arguments
            let ret = cfunc(...convertedArgs);

            // If the return type is a string, convert it back to JavaScript string
            if (!numericRet) {
                ensureJSsource();
                ret = Pointer_stringify(ret);
            }

            return ret;
        };
    }
}))();
Module["ccall"] = ccall;
Module["cwrap"] = cwrap;

function setValue(ptr, value, type, noSafe) {
    type = type || "i8";
    if (type.charAt(type.length - 1) === "*") type = "i32";
    switch (type) {
        case "i1":
            HEAP8[ptr >> 0] = value;
            break;
        case "i8":
            HEAP8[ptr >> 0] = value;
            break;
        case "i16":
            HEAP16[ptr >> 1] = value;
            break;
        case "i32":
            HEAP32[ptr >> 2] = value;
            break;
        case "i64": {
            let tempDouble = value;
            let tempI64;

            if (Math.abs(tempDouble) >= 1) {
                if (tempDouble > 0) {
                    tempI64 = [
                        value >>> 0,
                        (Math.min(Math.floor(tempDouble / 4294967296), 4294967295) | 0) >>> 0
                    ];
                } else {
                    tempI64 = [
                        value >>> 0,
                        (Math.ceil((tempDouble - (~~tempDouble >>> 0)) / 4294967296) | 0) >>> 0
                    ];
                }
            } else {
                tempI64 = [value >>> 0, 0];
            }

            // Assign values to HEAP32
            HEAP32[ptr >> 2] = tempI64[0];
            HEAP32[(ptr + 4) >> 2] = tempI64[1];
            break;
        }
        case "float":
            HEAPF32[ptr >> 2] = value;
            break;
        case "double":
            HEAPF64[ptr >> 3] = value;
            break;
        default:
            abort("invalid type for setValue: " + type)
    }
}
Module["setValue"] = setValue;

function getValue(ptr, type, noSafe) {
    type = type || "i8";
    if (type.charAt(type.length - 1) === "*") type = "i32";
    switch (type) {
        case "i1":
            return HEAP8[ptr >> 0];
        case "i8":
            return HEAP8[ptr >> 0];
        case "i16":
            return HEAP16[ptr >> 1];
        case "i32":
            return HEAP32[ptr >> 2];
        case "i64":
            return HEAP32[ptr >> 2];
        case "float":
            return HEAPF32[ptr >> 2];
        case "double":
            return HEAPF64[ptr >> 3];
        default:
            abort("invalid type for setValue: " + type)
    }
    return null
}
Module["getValue"] = getValue;
let ALLOC_NORMAL = 0;
let ALLOC_STACK = 1;
let ALLOC_STATIC = 2;
let ALLOC_DYNAMIC = 3;
let ALLOC_NONE = 4;
Module["ALLOC_NORMAL"] = ALLOC_NORMAL;
Module["ALLOC_STACK"] = ALLOC_STACK;
Module["ALLOC_STATIC"] = ALLOC_STATIC;
Module["ALLOC_DYNAMIC"] = ALLOC_DYNAMIC;
Module["ALLOC_NONE"] = ALLOC_NONE;

function allocate(slab, types, allocator, ptr) {
    const { zeroinit, size } = determineSlabProperties(slab);
    const singleType = typeof types === "string" ? types : null;
    const ret = allocateMemory(allocator, ptr, size, singleType);

    if (zeroinit) {
        initializeMemory(ret, size);
        return ret;
    }

    return copySlabData(slab, ret, size, singleType);
}

function determineSlabProperties(slab) {
    if (typeof slab === "number") {
        return { zeroinit: true, size: slab };
    }
    return { zeroinit: false, size: slab.length };
}

function allocateMemory(allocator, ptr, size, singleType) {
    if (allocator == ALLOC_NONE) {
        return ptr;
    }
    return [
        typeof _malloc === "function" ? _malloc : Runtime.staticAlloc,
        Runtime.stackAlloc,
        Runtime.staticAlloc,
        Runtime.dynamicAlloc
    ][allocator === undefined ? ALLOC_STATIC : allocator](Math.max(size, singleType ? 1 : types.length));
}

function initializeMemory(ret, size) {
    assert((ret & 3) === 0);
    const stop = ret + (size & ~3);
    for (let ptr = ret; ptr < stop; ptr += 4) {
        HEAP32[ptr >> 2] = 0;
    }
    for (let ptr = stop; ptr < ret + size; ptr++) {
        HEAP8[ptr >> 0] = 0;
    }
}

function copySlabData(slab, ret, size, singleType) {
    if (singleType === "i8") {
        if (slab.subarray || slab.slice) {
            HEAPU8.set(slab, ret);
        } else {
            HEAPU8.set(new Uint8Array(slab), ret);
        }
        return ret;
    }

    let i = 0, previousType;
    while (i < size) {
        let curr = slab[i];
        if (typeof curr === "function") {
            curr = Runtime.getFunctionIndex(curr);
        }
        const type = singleType || types[i];

        if (type === 0) {
            i++;
            continue;
        }

        const finalType = type === "i64" ? "i32" : type;
        setValue(ret + i, curr, finalType);
        const typeSize = (previousType !== finalType) ? Runtime.getNativeTypeSize(finalType) : 0;
        previousType = finalType;
        i += typeSize;
    }

    return ret;
}
Module["allocate"] = allocate;

function getMemory(size) {
    if (!staticSealed) return Runtime.staticAlloc(size);
    if (!runtimeInitialized) return Runtime.dynamicAlloc(size);
    return _malloc(size)
}
Module["getMemory"] = getMemory;

function Pointer_stringify(ptr, length) {
    if (length === 0 || !ptr) return ""; // Early return for edge cases

    let i = 0, hasUtf = 0, t;

    // Determine string length if not provided
    if (!length) {
        while (HEAPU8[ptr + i]) i++;
        length = i;
    }

    // Check if the string contains UTF-8 characters
    for (i = 0; i < length; i++) {
        t = HEAPU8[ptr + i];
        hasUtf |= t;
        if (!t) break;
    }

    // Fast path for ASCII strings
    if (hasUtf < 128) {
        return readAsciiString(ptr, length);
    }

    // Handle UTF-8 strings
    return Module["UTF8ToString"](ptr);
}
Module["Pointer_stringify"] = Pointer_stringify;

function AsciiToString(ptr) {
    let str = "";
    while (1) {
        let ch = HEAP8[ptr++ >> 0];
        if (!ch) return str;
        str += String.fromCharCode(ch)
    }
}
Module["AsciiToString"] = AsciiToString;

function stringToAscii(str, outPtr) {
    return writeAsciiToMemory(str, outPtr, false)
}
Module["stringToAscii"] = stringToAscii;
let UTF8Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf8") : undefined;
function UTF8ArrayToString(u8Array, idx) {
    let endPtr = findStringEnd(u8Array, idx);

    if (endPtr - idx > 16 && u8Array.subarray && UTF8Decoder) {
        return UTF8Decoder.decode(u8Array.subarray(idx, endPtr));
    } else {
        return decodeUTF8(u8Array, idx, endPtr);
    }
}

function findStringEnd(u8Array, idx) {
    let endPtr = idx;
    while (u8Array[endPtr]) ++endPtr;
    return endPtr;
}

function decodeUTF8(u8Array, idx, endPtr) {
    let str = "";
    while (idx < endPtr) {
        let u0 = u8Array[idx++];
        if (!u0) return str;
        str += decodeCodePoint(u8Array, u0, idx);
    }
    return str;
}

function decodeCodePoint(u8Array, u0, idx) {
    if (!(u0 & 128)) return String.fromCharCode(u0);

    let u1 = u8Array[idx++] & 63;
    if ((u0 & 224) === 192) {
        return String.fromCharCode((u0 & 31) << 6 | u1);
    }

    let u2 = u8Array[idx++] & 63;
    if ((u0 & 240) === 224) {
        u0 = (u0 & 15) << 12 | u1 << 6 | u2;
    } else {
        let u3 = u8Array[idx++] & 63;
        if ((u0 & 248) === 240) {
            u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | u3;
        } else {
            let u4 = u8Array[idx++] & 63;
            if ((u0 & 252) === 248) {
                u0 = (u0 & 3) << 24 | u1 << 18 | u2 << 12 | u3 << 6 | u4;
            } else {
                let u5 = u8Array[idx++] & 63;
                u0 = (u0 & 1) << 30 | u1 << 24 | u2 << 18 | u3 << 12 | u4 << 6 | u5;
            }
        }
    }

    return createUTF16Pair(u0);
}

function createUTF16Pair(u0) {
    if (u0 < 65536) {
        return String.fromCharCode(u0);
    } else {
        let ch = u0 - 65536;
        return String.fromCharCode(55296 | (ch >> 10), 56320 | (ch & 1023));
    }
}
Module["UTF8ArrayToString"] = UTF8ArrayToString;

function UTF8ToString(ptr) {
    return UTF8ArrayToString(HEAPU8, ptr)
}
Module["UTF8ToString"] = UTF8ToString;

function stringToUTF8Array(str, outU8Array, outIdx, maxBytesToWrite) {
    if (maxBytesToWrite <= 0) return 0;

    let startIdx = outIdx;
    let i = 0;
    while (i < str.length) {
        let u = str.charCodeAt(i);

        // Handle surrogate pairs (Unicode code points > 0xFFFF)
        if (isSurrogate(u)) {
            u = handleSurrogate(str, i); // Handle surrogate
            i += 2; // Move to the next character after the surrogate pair
        } else {
            i++; // Increment normally for non-surrogate characters
        }

        const res = encodeUTF8(u, outU8Array, outIdx, maxBytesToWrite, endIdx);
        if (res === -1) break; // Exit if not enough space
        outIdx += res; // Update output index
    }

    outU8Array[outIdx] = 0; // Null-terminate the output array
    return outIdx - startIdx;
}
Module["stringToUTF8Array"] = stringToUTF8Array;

function stringToUTF8(str, outPtr, maxBytesToWrite) {
    return stringToUTF8Array(str, HEAPU8, outPtr, maxBytesToWrite)
}
Module["stringToUTF8"] = stringToUTF8;

function lengthBytesUTF8(str) {
    let len = 0;
    let i = 0;

    while (i < str.length) {
        let u = str.charCodeAt(i);

        if (u >= 55296 && u <= 57343) {
            u = 65536 + ((u & 1023) << 10) | (str.charCodeAt(++i) & 1023);
        }

        if (u <= 127) {
            ++len;
        } else if (u <= 2047) {
            len += 2;
        } else if (u <= 65535) {
            len += 3;
        } else if (u <= 2097151) {
            len += 4;
        } else if (u <= 67108863) {
            len += 5;
        } else {
            len += 6;
        }

        ++i; // Increment i after processing the character
    }

    return len
}
Module["lengthBytesUTF8"] = lengthBytesUTF8;
let UTF16Decoder = typeof TextDecoder !== "undefined" ? new TextDecoder("utf-16le") : undefined;

function demangle(func) {
    let __cxa_demangle_func = Module["___cxa_demangle"] || Module["__cxa_demangle"];
    if (__cxa_demangle_func) {
        try {
            let s = func.substr(1);
            let len = lengthBytesUTF8(s) + 1;
            let buf = _malloc(len);
            stringToUTF8(s, buf, len);
            let status = _malloc(4);
            let ret = __cxa_demangle_func(buf, 0, 0, status);
            if (getValue(status, "i32") === 0 && ret) {
                return Pointer_stringify(ret)
            }
        } catch (e) { } finally {
            if (buf) _free(buf);
            if (ret) _free(ret)
        }
        return func
    }
    Runtime.warnOnce("warning: build with  -s DEMANGLE_SUPPORT=1  to link in libcxxabi demangling");
    return func
}

function demangleAll(text) {
    let regex = /__Z\w+/g; // Updated regex to use \w directly
    return text.replace(regex, x => {
        let y = demangle(x);
        return x === y ? x : `${x} [${y}]`; // Using template literals for readability
    });
}

function jsStackTrace() {
    let err = new Error;
    if (!err.stack) {
        try {
            throw new Error(0)
        } catch (e) {
            err = e
        }
        if (!err.stack) {
            return "(no stack trace available)"
        }
    }
    return err.stack.toString()
}

function stackTrace() {
    let js = jsStackTrace();
    if (Module["extraStackTrace"]) js += "\n" + Module["extraStackTrace"]();
    return demangleAll(js)
}
Module["stackTrace"] = stackTrace;
let WASM_PAGE_SIZE = 65536;
let ASMJS_PAGE_SIZE = 16777216;

function alignUp(x, multiple) {
    if (x % multiple > 0) {
        x += multiple - x % multiple
    }
    return x
}
let HEAP, buffer, HEAP8, HEAPU8, HEAP16, HEAPU16, HEAP32, HEAPU32, HEAPF32, HEAPF64;

function updateGlobalBuffer(buf) {
    Module["buffer"] = buffer = buf
}

function updateGlobalBufferViews() {
    Module["HEAP8"] = HEAP8 = new Int8Array(buffer);
    Module["HEAP16"] = HEAP16 = new Int16Array(buffer);
    Module["HEAP32"] = HEAP32 = new Int32Array(buffer);
    Module["HEAPU8"] = HEAPU8 = new Uint8Array(buffer);
    Module["HEAPU16"] = HEAPU16 = new Uint16Array(buffer);
    Module["HEAPU32"] = HEAPU32 = new Uint32Array(buffer);
    Module["HEAPF32"] = HEAPF32 = new Float32Array(buffer);
    Module["HEAPF64"] = HEAPF64 = new Float64Array(buffer)
}




let STATIC_BASE, STATICTOP, staticSealed;
let STACK_BASE, STACKTOP, STACK_MAX;
let DYNAMIC_BASE, DYNAMICTOP_PTR;
STATIC_BASE = STATICTOP = STACK_BASE = STACKTOP = STACK_MAX = DYNAMIC_BASE = DYNAMICTOP_PTR = 0;
staticSealed = false;

function abortOnCannotGrowMemory() {
    abort("Cannot enlarge memory arrays. Either (1) compile with  -s TOTAL_MEMORY=X  with X higher than the current value " + TOTAL_MEMORY + ", (2) compile with  -s ALLOW_MEMORY_GROWTH=1  which allows increasing the size at runtime, or (3) if you want malloc to return NULL (0) instead of this abort, compile with  -s ABORTING_MALLOC=0 ")
}

function enlargeMemory() {
    let memoryGrowthSuccess = tryToGrowMemory();  // This is a placeholder for your actual logic

    if (!memoryGrowthSuccess) {
        return abortOnCannotGrowMemory();  // Return false if it fails
    }

    return true;
}
let TOTAL_STACK = Module["TOTAL_STACK"] || 5242880;
let TOTAL_MEMORY = Module["TOTAL_MEMORY"] || 67108864;
if (TOTAL_MEMORY < TOTAL_STACK) Module.printErr("TOTAL_MEMORY should be larger than TOTAL_STACK, was " + TOTAL_MEMORY + "! (TOTAL_STACK=" + TOTAL_STACK + ")");
if (Module["buffer"]) {
    buffer = Module["buffer"]
} else if (typeof WebAssembly === "object" && typeof WebAssembly.Memory === "function") {
    Module["wasmMemory"] = new WebAssembly.Memory({
        "initial": TOTAL_MEMORY / WASM_PAGE_SIZE,
        "maximum": TOTAL_MEMORY / WASM_PAGE_SIZE
    });
    buffer = Module["wasmMemory"].buffer
} else {
    buffer = new ArrayBuffer(TOTAL_MEMORY)
}

updateGlobalBufferViews();

function getTotalMemory() {
    return TOTAL_MEMORY
}
HEAP32[0] = 1668509029;
HEAP16[1] = 25459;
if (HEAPU8[2] !== 115 || HEAPU8[3] !== 99) throw new Error("Runtime error: expected the system to be little-endian!");
Module["HEAP"] = HEAP;
Module["buffer"] = buffer;
Module["HEAP8"] = HEAP8;
Module["HEAP16"] = HEAP16;
Module["HEAP32"] = HEAP32;
Module["HEAPU8"] = HEAPU8;
Module["HEAPU16"] = HEAPU16;
Module["HEAPU32"] = HEAPU32;
Module["HEAPF32"] = HEAPF32;
Module["HEAPF64"] = HEAPF64;

function callRuntimeCallbacks(callbacks) {
    while (callbacks.length > 0) {
        let callback = callbacks.shift();
        if (typeof callback == "function") {
            callback();
            continue
        }
        let func = callback.func;
        if (typeof func === "number") {
            if (callback.arg === undefined) {
                Module["dynCall_v"](func)
            } else {
                Module["dynCall_vi"](func, callback.arg)
            }
        } else {
            func(callback.arg === undefined ? null : callback.arg)
        }
    }
}
let __ATPRERUN__ = [];
let __ATINIT__ = [];
let __ATMAIN__ = [];
let __ATEXIT__ = [];
let __ATPOSTRUN__ = [];
let runtimeInitialized = false;
let runtimeExited = false;

function preRun() {
    if (Module["preRun"]) {
        if (typeof Module["preRun"] == "function") Module["preRun"] = [Module["preRun"]];
        while (Module["preRun"].length) {
            addOnPreRun(Module["preRun"].shift())
        }
    }
    callRuntimeCallbacks(__ATPRERUN__)
}

function ensureInitRuntime() {
    if (runtimeInitialized) return;
    runtimeInitialized = true;
    callRuntimeCallbacks(__ATINIT__)
}

function preMain() {
    callRuntimeCallbacks(__ATMAIN__)
}

function exitRuntime() {
    callRuntimeCallbacks(__ATEXIT__);
    runtimeExited = true
}

function postRun() {
    if (Module["postRun"]) {
        if (typeof Module["postRun"] == "function") Module["postRun"] = [Module["postRun"]];
        while (Module["postRun"].length) {
            addOnPostRun(Module["postRun"].shift())
        }
    }
    callRuntimeCallbacks(__ATPOSTRUN__)
}

function addOnPreRun(cb) {
    __ATPRERUN__.unshift(cb)
}
Module["addOnPreRun"] = addOnPreRun;

function addOnInit(cb) {
    __ATINIT__.unshift(cb)
}
Module["addOnInit"] = addOnInit;

function addOnPreMain(cb) {
    __ATMAIN__.unshift(cb)
}
Module["addOnPreMain"] = addOnPreMain;

function addOnExit(cb) {
    __ATEXIT__.unshift(cb)
}
Module["addOnExit"] = addOnExit;

function addOnPostRun(cb) {
    __ATPOSTRUN__.unshift(cb)
}
Module["addOnPostRun"] = addOnPostRun;

function intArrayFromString(stringy, dontAddNull, length) {
    let len = length > 0 ? length : lengthBytesUTF8(stringy) + 1;
    let u8array = new Array(len);
    let numBytesWritten = stringToUTF8Array(stringy, u8array, 0, u8array.length);
    if (dontAddNull) u8array.length = numBytesWritten;
    return u8array
}
Module["intArrayFromString"] = intArrayFromString;

function intArrayToString(array) {
    return Array.from(array, chr => String.fromCharCode(chr > 255 ? chr & 255 : chr)).join("");
}
Module["intArrayToString"] = intArrayToString;

function writeStringToMemory(string, buffer, dontAddNull) {
    Runtime.warnOnce("writeStringToMemory is deprecated and should not be called! Use stringToUTF8() instead!");
    let lastChar, end;
    if (dontAddNull) {
        end = buffer + lengthBytesUTF8(string);
        lastChar = HEAP8[end]
    }
    stringToUTF8(string, buffer, Infinity);
    if (dontAddNull) HEAP8[end] = lastChar
}
Module["writeStringToMemory"] = writeStringToMemory;

function writeArrayToMemory(array, buffer) {
    HEAP8.set(array, buffer)
}
Module["writeArrayToMemory"] = writeArrayToMemory;

function writeAsciiToMemory(str, buffer, dontAddNull) {
    for (let i = 0; i < str.length; ++i) {
        HEAP8[buffer++ >> 0] = str.charCodeAt(i)
    }
    if (!dontAddNull) HEAP8[buffer >> 0] = 0
}
Module["writeAsciiToMemory"] = writeAsciiToMemory;
if (!Math["imul"] || Math["imul"](4294967295, 5) !== -5) Math["imul"] = function imul(a, b) {
    let ah = a >>> 16;
    let al = a & 65535;
    let bh = b >>> 16;
    let bl = b & 65535;
    return al * bl + (ah * bl + al * bh << 16) | 0
};
Math.imul = Math["imul"] || console.log;
if (!Math["fround"]) {
    let froundBuffer = new Float32Array(1);
    Math["fround"] = (function (x) {
        froundBuffer[0] = x;
        return froundBuffer[0]
    })
}
Math.fround = Math["fround"] || console.log;
if (!Math["clz32"]) Math["clz32"] = (function (x) {
    x = x >>> 0;
    for (let i = 0; i < 32; i++) {
        if (x & 1 << 31 - i) return i
    }
    return 32
});
Math.clz32 = Math["clz32"] || console.log;
if (!Math["trunc"]) Math["trunc"] = (function (x) {
    return x < 0 ? Math.ceil(x) : Math.floor(x)
});
Math.trunc = Math["trunc"] || console.log;
let Math_abs = Math.abs;
let Math_cos = Math.cos;
let Math_sin = Math.sin;
let Math_tan = Math.tan;
let Math_acos = Math.acos;
let Math_asin = Math.asin;
let Math_atan = Math.atan;
let Math_atan2 = Math.atan2;
let Math_exp = Math.exp;
let Math_log = Math.log;
let Math_sqrt = Math.sqrt;
let Math_ceil = Math.ceil;
let Math_floor = Math.floor;
let Math_pow = Math.pow;
let Math_imul = Math.imul;
let Math_fround = Math.fround;
let Math_round = Math.round;
let Math_min = Math.min;
let Math_clz32 = Math.clz32;
let Math_trunc = Math.trunc;
let runDependencies = 0;
let runDependencyWatcher = null;
let dependenciesFulfilled = null;

function addRunDependency(id) {
    runDependencies++;
    if (Module["monitorRunDependencies"]) {
        Module["monitorRunDependencies"](runDependencies)
    }
}
Module["addRunDependency"] = addRunDependency;

function removeRunDependency(id) {
    runDependencies--;
    if (Module["monitorRunDependencies"]) {
        Module["monitorRunDependencies"](runDependencies)
    }
    if (runDependencies == 0) {
        if (runDependencyWatcher !== null) {
            clearInterval(runDependencyWatcher);
            runDependencyWatcher = null
        }
        if (dependenciesFulfilled) {
            let callback = dependenciesFulfilled;
            dependenciesFulfilled = null;
            callback()
        }
    }
}


Module["removeRunDependency"] = removeRunDependency;
Module["preloadedImages"] = {};
Module["preloadedAudios"] = {};
let memoryInitializer = null;

function integrateWasmJS(Module) {
    let method = Module["wasmJSMethod"] || "native-wasm";
    Module["wasmJSMethod"] = method;
    let wasmTextFile = Module["wasmTextFile"] || "opus.wasm.wast";
    let wasmBinaryFile = Module["wasmBinaryFile"] || self["cr_opusWasmBinaryUrl"] || "opus.wasm.wasm";
    let asmjsCodeFile = Module["asmjsCodeFile"] || "opus.wasm.temp.asm.js";
    if (typeof Module["locateFile"] === "function") {
        wasmTextFile = Module["locateFile"](wasmTextFile);
        wasmBinaryFile = Module["locateFile"](wasmBinaryFile);
        asmjsCodeFile = Module["locateFile"](asmjsCodeFile)
    }
    let wasmPageSize = 64 * 1024;
    let asm2wasmImports = {
        "f64-rem": (function (x, y) {
            return x % y
        }),
        "f64-to-int": (function (x) {
            return x | 0
        }),
        "i32s-div": (function (x, y) {
            return (x | 0) / (y | 0) | 0
        }),
        "i32u-div": (function (x, y) {
            return (x >>> 0) / (y >>> 0) >>> 0
        }),
        "i32s-rem": (function (x, y) {
            return (x | 0) % (y | 0) | 0
        }),
        "i32u-rem": (function (x, y) {
            return (x >>> 0) % (y >>> 0) >>> 0
        }),
        "debugger": (function () {
            debugger
        })
    };
    let info = {
        "global": null,
        "env": null,
        "asm2wasm": asm2wasmImports,
        "parent": Module
    };
    let exports = null;

    function lookupImport(mod, base) {
        let lookup = info;

        if (mod.indexOf(".") < 0) {
            lookup = lookup?.[mod]; // Use optional chaining here
        } else {
            let parts = mod.split(".");
            lookup = lookup?.[parts[0]]; // Use optional chaining here
            lookup = lookup?.[parts[1]]; // Use optional chaining here
        }

        if (base) {
            lookup = lookup?.[base]; // Use optional chaining here
        }

        if (lookup === undefined) {
            abort("bad lookupImport to (" + mod + ")." + base);
        }

        return lookup;
    }


    function mergeMemory(newBuffer) {
        let oldBuffer = Module["buffer"];
        if (newBuffer.byteLength < oldBuffer.byteLength) {
            Module["printErr"]("the new buffer in mergeMemory is smaller than the previous one. in native wasm, we should grow memory here")
        }
        let oldView = new Int8Array(oldBuffer);
        let newView = new Int8Array(newBuffer);
        if (!memoryInitializer) {
            oldView.set(newView.subarray(Module["STATIC_BASE"], Module["STATIC_BASE"] + Module["STATIC_BUMP"]), Module["STATIC_BASE"])
        }
        newView.set(oldView);
        updateGlobalBuffer(newBuffer);
        updateGlobalBufferViews()
    }

    function fixImports(imports) {
        if (!0) return imports;
        let ret = {};
        for (let i in imports) {
            let fixed = i;
            if (fixed.startsWith("_")) {
                fixed = fixed.slice(1); // Alternatively, use slice instead of substr
            }
            ret[fixed] = imports[i]
        }
        return ret
    }

    function getBinary() {
        try {
            let binary;
            if (Module["wasmBinary"]) {
                binary = Module["wasmBinary"];
                binary = new Uint8Array(binary)
            } else if (Module["readBinary"]) {
                binary = Module["readBinary"](wasmBinaryFile)
            } else {
                throw new Error("on the web, we need the wasm binary to be preloaded and set on Module['wasmBinary']. emcc.py will do that for you when generating HTML (but not JS)")
            }
            return binary
        } catch (err) {
            abort(err)
        }
    }

    function getBinaryPromise() {
        return new Promise((resolve, reject) => {
            const buffer = self.sentBuffers.get("opus-decoder-wasm");
            if (buffer)
                return resolve(new Uint8Array(buffer));

            const blob = self.sentBlobs.get("opus-decoder-wasm");
            if (!blob)
                return reject("not yet received opus blob");

            const fileReader = new FileReader();
            fileReader.onload = () => resolve(new Uint8Array(fileReader["result"]));
            fileReader.onerror = () => reject(fileReader["error"]);
            fileReader.readAsArrayBuffer(blob);
        });
    }

    function doJustAsm(global, env, providedBuffer) {
        if (typeof Module["asm"] !== "function" || Module["asm"] === methodHandler) {
            if (!Module["asmPreload"]) {
                // Fetch the asm.js or WebAssembly code from the specified file
                fetch(asmjsCodeFile)
                    .then(response => {
                        if (!response.ok) {
                            throw new Error('Network response was not ok');
                        }
                        return response.arrayBuffer(); // Get the raw bytes
                    })
                    .then(bytes => WebAssembly.instantiate(bytes, { env: Module['env'] }))
                    .then(result => {
                        Module['asm'] = result.instance.exports; // Export the instance
                        console.log('ASM.js code loaded and executed successfully.');
                    })
                    .catch(error => {
                        console.error('Error loading WebAssembly:', error);
                    });
            }
            else {
                Module["asm"] = Module["asmPreload"]
            }
        }
        if (typeof Module["asm"] !== "function") {
            Module["printErr"]("asm evalling did not set the module properly");
            return false
        }
        return Module["asm"](global, env, providedBuffer)
    }

    function doNativeWasm(global, env, providedBuffer) {
        if (typeof WebAssembly !== "object") {
            Module["printErr"]("no native wasm support detected");
            return false
        }
        if (!(Module["wasmMemory"] instanceof WebAssembly.Memory)) {
            Module["printErr"]("no native wasm Memory in use");
            return false
        }
        env["memory"] = Module["wasmMemory"];
        info["global"] = {
            "NaN": NaN,
            "Infinity": Infinity
        };
        info["global.Math"] = global.Math;
        info["env"] = env;

        function receiveInstance(instance) {
            exports = instance.exports;
            if (exports.memory) mergeMemory(exports.memory);
            Module["asm"] = exports;
            Module["usingWasm"] = true;
            removeRunDependency("wasm-instantiate")
        }
        addRunDependency("wasm-instantiate");
        if (Module["instantiateWasm"]) {
            try {
                return Module["instantiateWasm"](info, receiveInstance)
            } catch (e) {
                Module["printErr"]("Module.instantiateWasm callback failed with error: " + e);
                return false
            }
        }
        getBinaryPromise().then((function (binary) {
            return WebAssembly.instantiate(binary, info)
        })).then((function (output) {
            receiveInstance(output["instance"])
        })).catch((function (reason) {
            Module["printErr"]("failed to asynchronously prepare wasm: " + reason);
            abort(reason)
        }));
        return {}
    }

    function doWasmPolyfill(global, env, providedBuffer, method) {
        if (typeof WasmJS !== "function") {
            Module["printErr"]("WasmJS not detected - polyfill not bundled?");
            return false
        }
        let wasmJS = WasmJS({});
        wasmJS["outside"] = Module;
        wasmJS["info"] = info;
        wasmJS["lookupImport"] = lookupImport;
        assert(providedBuffer === Module["buffer"]);
        info.global = global;
        info.env = env;
        assert(providedBuffer === Module["buffer"]);
        env["memory"] = providedBuffer;
        assert(env["memory"] instanceof ArrayBuffer);
        wasmJS["providedTotalMemory"] = Module["buffer"].byteLength;
        let code;
        if (method === "interpret-binary") {
            code = getBinary()
        } else {
            code = Module["read"](method == "interpret-asm2wasm" ? asmjsCodeFile : wasmTextFile)
        }
        let temp;
        if (method == "interpret-asm2wasm") {
            temp = wasmJS["_malloc"](code.length + 1);
            wasmJS["writeAsciiToMemory"](code, temp);
            wasmJS["_load_asm2wasm"](temp)
        } else if (method === "interpret-s-expr") {
            temp = wasmJS["_malloc"](code.length + 1);
            wasmJS["writeAsciiToMemory"](code, temp);
            wasmJS["_load_s_expr2wasm"](temp)
        } else if (method === "interpret-binary") {
            temp = wasmJS["_malloc"](code.length);
            wasmJS["HEAPU8"].set(code, temp);
            wasmJS["_load_binary2wasm"](temp, code.length)
        } else {
            throw new Error("what? " + method)
        }
        wasmJS["_free"](temp);
        wasmJS["_instantiate"](temp);
        if (Module["newBuffer"]) {
            mergeMemory(Module["newBuffer"]);
            Module["newBuffer"] = null
        }
        exports = wasmJS["asmExports"];
        return exports
    }
    Module["asmPreload"] = Module["asm"];
    let asmjsReallocBuffer = Module["reallocBuffer"];
    let wasmReallocBuffer = (function (size) {
        let PAGE_MULTIPLE = Module["usingWasm"] ? WASM_PAGE_SIZE : ASMJS_PAGE_SIZE;
        size = alignUp(size, PAGE_MULTIPLE);
        let old = Module["buffer"];
        let oldSize = old.byteLength;
        if (Module["usingWasm"]) {
            try {
                let result = Module["wasmMemory"].grow((size - oldSize) / wasmPageSize);
                if (result !== (-1 | 0)) {
                    Module["buffer"] = Module["wasmMemory"].buffer; // Extracted assignment
                    return Module["buffer"]; // Return the assigned value
                } else {
                    return null; // Return null if the condition is not met
                }

            } catch (e) {
                return null
            }
        } else {
            exports["__growWasmMemory"]((size - oldSize) / wasmPageSize);
            return Module["buffer"] !== old ? Module["buffer"] : null
        }
    });
    Module["reallocBuffer"] = (function (size) {
        if (finalMethod === "asmjs") {
            return asmjsReallocBuffer(size)
        } else {
            return wasmReallocBuffer(size)
        }
    });
    let finalMethod = "asmjs";
    Module["asm"] = (function (global, env, providedBuffer) {
        // Fix the imports
        global = fixImports(global);
        env = fixImports(env);
    
        // Function to set up the WebAssembly table
        function setupTable() {
            const TABLE_SIZE = Module["wasmTableSize"] || 1024;  // Default size if undefined
            const MAX_TABLE_SIZE = Module["wasmMaxTableSize"];
            
            // Check if WebAssembly Table is supported
            if (typeof WebAssembly === "object" && typeof WebAssembly.Table === "function") {
                env["table"] = new WebAssembly.Table({
                    initial: TABLE_SIZE,
                    maximum: MAX_TABLE_SIZE || undefined, // Only add maximum if defined
                    element: "anyfunc"
                });
            } else {
                // Fallback: Use a simple array if WebAssembly.Table is not supported
                env["table"] = new Array(TABLE_SIZE);
            }
            Module["wasmTable"] = env["table"];
        }
    
        // Set up memory base if not already defined
        function setupMemoryBase() {
            if (!env["memoryBase"]) {
                env["memoryBase"] = Module["STATIC_BASE"];
            }
        }
    
        // Set up table base if not already defined
        function setupTableBase() {
            if (!env["tableBase"]) {
                env["tableBase"] = 0;
            }
        }
    
        // Function to handle method processing
        function handleMethods(methods) {
            for (const method of methods) {
                let exports = null;
    
                if (method === "native-wasm") {
                    exports = doNativeWasm(global, env, providedBuffer);
                } else if (method === "asmjs") {
                    exports = doJustAsm(global, env, providedBuffer);
                } else if (["interpret-asm2wasm", "interpret-s-expr", "interpret-binary"].includes(method)) {
                    exports = doWasmPolyfill(global, env, providedBuffer, method);
                } else {
                    abort("bad method: " + method);
                }
    
                // If a valid export is found, return it
                if (exports) {
                    return exports;
                }
            }
    
            return null;  // No valid exports found
        }
    
        // Initialize the table, memoryBase, and tableBase
        setupTable();
        setupMemoryBase();
        setupTableBase();
    
        // Process the methods (split the comma-separated string)
        const methods = method.split(",");
        const exports = handleMethods(methods);
    
        // If no method returns valid exports, throw an error
        if (!exports) {
            throw new Error("no binaryen method succeeded. consider enabling more options, like interpreting, if you want that: https://github.com/kripken/emscripten/wiki/WebAssembly#binaryen-methods");
        }
    
        return exports;  // Return the valid exports
    });
    
    


    let methodHandler = Module["asm"]
}








integrateWasmJS(Module);
let ASM_CONSTS = [];
STATIC_BASE = Runtime.GLOBAL_BASE;
STATICTOP = STATIC_BASE + 28816;
__ATINIT__.push();
memoryInitializer = Module["wasmJSMethod"].indexOf("asmjs") >= 0 || Module["wasmJSMethod"].indexOf("interpret-asm2wasm") >= 0 ? "opus.wasm.js.mem" : null;
const STATIC_BUMP = 28816;
Module["STATIC_BASE"] = STATIC_BASE;
Module["STATIC_BUMP"] = STATIC_BUMP;
const tempDoublePtr = STATICTOP;
STATICTOP += 16;

function _llvm_stackrestore(p) {
    const self = _llvm_stacksave; // Use const to reference _llvm_stacksave
    let ret = self.LLVM_SAVEDSTACKS[p]; // Use let for block-scoped variable
    self.LLVM_SAVEDSTACKS.splice(p, 1);
    Runtime.stackRestore(ret);
}

function ___setErrNo(value) {
    if (Module["___errno_location"]) HEAP32[Module["___errno_location"]() >> 2] = value;
    return value
}


function _emscripten_memcpy_big(dest, src, num) {
    HEAPU8.set(HEAPU8.subarray(src, src + num), dest);
    return dest
}

function _llvm_stacksave() {
    const self = _llvm_stacksave; // Use const to reference the function itself
    if (!self.LLVM_SAVEDSTACKS) {
        self.LLVM_SAVEDSTACKS = [];
    }
    self.LLVM_SAVEDSTACKS.push(Runtime.stackSave());


    return self.LLVM_SAVEDSTACKS.length - 1;
}

DYNAMICTOP_PTR = allocate(1, "i32", ALLOC_STATIC);
STACK_BASE = STACKTOP = Runtime.alignMemory(STATICTOP);
STACK_MAX = STACK_BASE + TOTAL_STACK;
DYNAMIC_BASE = Runtime.alignMemory(STACK_MAX);
HEAP32[DYNAMICTOP_PTR >> 2] = DYNAMIC_BASE;
staticSealed = true;
Module["wasmTableSize"] = 0;
Module["wasmMaxTableSize"] = 0;
Module.asmGlobalArg = {
    "Math": Math,
    "Int8Array": Int8Array,
    "Int16Array": Int16Array,
    "Int32Array": Int32Array,
    "Uint8Array": Uint8Array,
    "Uint16Array": Uint16Array,
    "Uint32Array": Uint32Array,
    "Float32Array": Float32Array,
    "Float64Array": Float64Array,
    "NaN": NaN,
    "Infinity": Infinity
};
Module.asmLibraryArg = {
    "abort": abort,
    "assert": assert,
    "enlargeMemory": enlargeMemory,
    "getTotalMemory": getTotalMemory,
    "abortOnCannotGrowMemory": abortOnCannotGrowMemory,
    "_llvm_stackrestore": _llvm_stackrestore,
    "_llvm_stacksave": _llvm_stacksave,
    "_emscripten_memcpy_big": _emscripten_memcpy_big,
    "___setErrNo": ___setErrNo,
    "DYNAMICTOP_PTR": DYNAMICTOP_PTR,
    "tempDoublePtr": tempDoublePtr,
    "ABORT": ABORT,
    "STACKTOP": STACKTOP,
    "STACK_MAX": STACK_MAX
};
let asm = Module["asm"](Module.asmGlobalArg, Module.asmLibraryArg, buffer);
Module["asm"] = asm;

Module["_malloc"] = (function () {
    return Module["asm"]["_malloc"].apply(null, arguments)
});

Module["_free"] = function () {
    return Module["asm"]["_free"].apply(null, arguments);
};
Module["_memcpy"] = (function () {
    return Module["asm"]["_memcpy"].apply(null, arguments)
});

Module["_memmove"] = (function () {
    return Module["asm"]["_memmove"].apply(null, arguments)
});

Module["_memset"] = (function () {
    return Module["asm"]["_memset"].apply(null, arguments)
});
Module["_sbrk"] = (function () {
    return Module["asm"]["_sbrk"].apply(null, arguments)
});





Runtime.stackAlloc = Module["stackAlloc"];
Runtime.stackSave = Module["stackSave"];
Runtime.stackRestore = Module["stackRestore"];
Runtime.establishStackSpace = Module["establishStackSpace"];
Runtime.setTempRet0 = Module["setTempRet0"];
Runtime.getTempRet0 = Module["getTempRet0"];
Module["asm"] = asm;
if (memoryInitializer) {
    if (typeof Module["locateFile"] === "function") {
        memoryInitializer = Module["locateFile"](memoryInitializer)
    } else if (Module["memoryInitializerPrefixURL"]) {
        memoryInitializer = Module["memoryInitializerPrefixURL"] + memoryInitializer
    }
    if (ENVIRONMENT_IS_NODE || ENVIRONMENT_IS_SHELL) {
        let data = Module["readBinary"](memoryInitializer);
        HEAPU8.set(data, Runtime.GLOBAL_BASE)
    } else {
        addRunDependency("memory initializer");
        let applyMemoryInitializer = (function (data) {
            if (data.byteLength) data = new Uint8Array(data);
            HEAPU8.set(data, Runtime.GLOBAL_BASE);
            if (Module["memoryInitializerRequest"]) delete Module["memoryInitializerRequest"].response;
            removeRunDependency("memory initializer")
        });

        function doBrowserLoad() {
            Module["readAsync"](memoryInitializer, applyMemoryInitializer, (function () {
                throw new Error("could not load memory initializer " + memoryInitializer)
            }))
        }
        if (Module["memoryInitializerRequest"]) {
            function useRequest() {
                let request = Module["memoryInitializerRequest"];
                if (request.status !== 200 && request.status !== 0) {
                    console.warn("a problem seems to have happened with Module.memoryInitializerRequest, status: " + request.status + ", retrying " + memoryInitializer);
                    doBrowserLoad();
                    return
                }
                applyMemoryInitializer(request.response)
            }
            if (Module["memoryInitializerRequest"].response) {
                setTimeout(useRequest, 0)
            } else {
                Module["memoryInitializerRequest"].addEventListener("load", useRequest)
            }
        } else {
            doBrowserLoad()
        }
    }
}

function ExitStatus(status) {
    this.name = "ExitStatus";
    this.message = "Program terminated with exit(" + status + ")";
    this.status = status
}
ExitStatus.prototype = new Error;
ExitStatus.prototype.constructor = ExitStatus;
let initialStackTop;
let preloadStartTime = null;
let calledMain = false;
dependenciesFulfilled = function runCaller() {
    if (!Module["calledRun"]) run();
    if (!Module["calledRun"]) dependenciesFulfilled = runCaller
};
Module["callMain"] = Module.callMain = function callMain(args) {
    args = args || [];
    ensureInitRuntime();
    let argc = args.length + 1;

    function pad() {
        for (let i = 0; i < 4 - 1; i++) {
            argv.push(0)
        }
    }
    let argv = [allocate(intArrayFromString(Module["thisProgram"]), "i8", ALLOC_NORMAL)];
    pad();
    for (let i = 0; i < argc - 1; i = i + 1) {
        argv.push(allocate(intArrayFromString(args[i]), "i8", ALLOC_NORMAL));
        pad()
    }
    argv.push(0);
    argv = allocate(argv, "i32", ALLOC_NORMAL);
    try {
        let ret = Module["_main"](argc, argv, 0);
        exit(ret, true)
    } catch (e) {
        if (e instanceof ExitStatus) {
            return
        } else if (e == "SimulateInfiniteLoop") {
            Module["noExitRuntime"] = true;
            return
        } else {
            let toLog = e;
            if (e && typeof e === "object" && e.stack) {
                toLog = [e, e.stack]
            }
            Module.printErr("exception thrown: " + toLog);
            Module["quit"](1, e)
        }
    } finally {
        calledMain = true
    }
};

function run(args) {
    args = args || Module["arguments"];
    if (preloadStartTime === null) preloadStartTime = Date.now();
    if (runDependencies > 0) {
        return
    }
    preRun();
    if (runDependencies > 0) return;
    if (Module["calledRun"]) return;

    function doRun() {
        if (Module["calledRun"]) return;
        Module["calledRun"] = true;
        if (ABORT) return;
        ensureInitRuntime();
        preMain();
        if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
        if (Module["_main"] && shouldRunNow) Module["callMain"](args);
        postRun()
    }
    if (Module["setStatus"]) {
        Module["setStatus"]("Running...");
        setTimeout((function () {
            setTimeout((function () {
                Module["setStatus"]("")
            }), 1);
            doRun()
        }), 1)
    } else {
        doRun()
    }
}
Module["run"] = Module.run = run;

function exit(status, implicit) {
    if (implicit && Module["noExitRuntime"]) {
        return
    }
    if (Module["noExitRuntime"]) {
        return
    }
    else {
        ABORT = true;
        EXITSTATUS = status;
        STACKTOP = initialStackTop;
        exitRuntime();
        if (Module["onExit"]) Module["onExit"](status)
    }
    if (ENVIRONMENT_IS_NODE) {
        process["exit"](status)
    }
    Module["quit"](status, new ExitStatus(status))
}
Module["exit"] = Module.exit = exit;
let abortDecorators = [];

function abort(what) {
    if (Module["onAbort"]) {
        Module["onAbort"](what)
    }
    if (what !== undefined) {
        Module.print(what);
        Module.printErr(what);
        what = JSON.stringify(what)
    } else {
        what = ""
    }
    ABORT = true;
    EXITSTATUS = 1;
    let extra = "\nIf this abort() is unexpected, build with -s ASSERTIONS=1 which can give more information.";
    let output = "abort(" + what + ") at " + stackTrace() + extra;
    if (abortDecorators) {
        abortDecorators.forEach((function (decorator) {
            output = decorator(output, what)
        }))
    }
    throw new Error(output)
}
Module["abort"] = Module.abort = abort;
if (Module["preInit"]) {
    if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
    while (Module["preInit"].length > 0) {
        Module["preInit"].pop()()
    }
}
let shouldRunNow = true;
if (Module["noInitialRun"]) {
    shouldRunNow = false
}
Module["noExitRuntime"] = true;
run()