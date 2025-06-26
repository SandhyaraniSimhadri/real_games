'use strict';
(function() {
    let pass = true;
    
    // Use a variable that can potentially be undefined or null
    let testValue;
    
    // Check if nullish coalescing works properly
    if ((testValue ?? 2) !== 2) pass = false;

    // Set the flag if the test passes
    if (pass) window["C3_ModernJSSupport_OK"] = true;
})();
