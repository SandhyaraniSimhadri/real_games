"use strict";

const OFFLINE_DATA_FILE = "offline.js";
const CACHE_NAME_PREFIX = "c2offline";
const BROADCASTCHANNEL_NAME = "offline";
const CONSOLE_PREFIX = "[SW] ";

// Create a BroadcastChannel if supported.
const broadcastChannel = (typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(BROADCASTCHANNEL_NAME));

//////////////////////////////////////
// Utility methods
function PostBroadcastMessage(o)
{
	if (!broadcastChannel)
		return;		// not supported
	
	// Impose artificial (and arbitrary!) delay of 3 seconds to make sure client is listening by the time the message is sent.
	// Note we could remove the delay on some messages, but then we create a race condition where sometimes messages can arrive
	// in the wrong order (e.g. "update ready" arrives before "started downloading update"). So to keep the consistent ordering,
	// delay all messages by the same amount.
	setTimeout(() => broadcastChannel.postMessage(o), 3000);
};

function Broadcast(type)
{
	PostBroadcastMessage({
		"type": type
	});
};

function BroadcastDownloadingUpdate(version)
{
	PostBroadcastMessage({
		"type": "downloading-update",
		"version": version
	});
}

function BroadcastUpdateReady(version)
{
	PostBroadcastMessage({
		"type": "update-ready",
		"version": version
	});
}

function GetCacheBaseName()
{
	// Include the scope to avoid name collisions with any other SWs on the same origin.
	// e.g. "c2offline-https://example.com/foo/" (won't collide with anything under bar/)
	return CACHE_NAME_PREFIX + "-" + self.registration.scope;
};

function GetCacheVersionName(version)
{
	// Append the version number to the cache name.
	// e.g. "c2offline-https://example.com/foo/-v2"
	return GetCacheBaseName() + "-v" + version;
};

// Return caches.keys() filtered down to just caches we're interested in (with the right base name).
// This filters out caches from unrelated scopes.
function GetAvailableCacheNames()
{
	return caches.keys()
	.then(cacheNames =>
	{
		const cacheBaseName = GetCacheBaseName();
		return cacheNames.filter(n => n.startsWith(cacheBaseName));
	});
};

// Identify if an update is pending, which is the case when we have 2 or more available caches.
// One must be an update that is waiting, since the next navigate that does an upgrade will
// delete all the old caches leaving just one currently-in-use cache.
function IsUpdatePending()
{
	return GetAvailableCacheNames()
	.then(availableCacheNames => availableCacheNames.length >= 2);
};

// Automatically deduce the main page URL (e.g. index.html or main.aspx) from the available browser windows.
// This prevents having to hard-code an index page in the file list, implicitly caching it like AppCache did.
function GetMainPageUrl()
{
	return clients.matchAll({
		includeUncontrolled: true,
		type: "window"
	})
	.then(clients =>
	{
		for (let c of clients)
		{
			// Parse off the scope from the full client URL, e.g. https://example.com/index.html -> index.html
			let url = c.url;
			if (url.startsWith(self.registration.scope))
				url = url.substring(self.registration.scope.length);
			
			if (url && url !== "/")		// ./ is also implicitly cached so don't bother returning that
			{
				// If the URL is solely a search string, prefix it with / to ensure it caches correctly.
				// e.g. https://example.com/?foo=bar needs to cache as /?foo=bar, not just ?foo=bar.
				if (url.startsWith("?"))
					url = "/" + url;
				
				return url;
			}
		}
		
		return "";		// no main page URL could be identified
	});
};

// Hack to fetch optionally bypassing HTTP cache until fetch cache options are supported in Chrome (crbug.com/453190)
function fetchWithBypass(request, bypassCache)
{
	if (typeof request === "string")
		request = new Request(request);
	
	if (bypassCache)
	{
		const url = new URL(request.url);
		url.search += `${Date.now()}`;

		return fetch(url, {
			headers: request.headers,
			mode: request.mode,
			credentials: request.credentials,
			redirect: request.redirect,
			cache: "no-store"
		});
	}
	else
	{
		// bypass disabled: perform normal fetch which is allowed to return from HTTP cache
		return fetch(request);
	}
};

// Effectively a cache.addAll() that only creates the cache on all requests being successful (as a weak attempt at making it atomic)
// and can optionally cache-bypass with fetchWithBypass in every request
function CreateCacheFromFileList(cacheName, fileList, bypassCache)
{
	// Kick off all requests and wait for them all to complete
	return Promise.all(fileList.map(url => fetchWithBypass(url, bypassCache)))
	.then(responses =>
	{
		// Check if any request failed. If so don't move on to opening the cache.
		// This makes sure we only open a cache if all requests succeeded.
		let allOk = true;
		
		for (let response of responses)
		{
			if (!response.ok)
			{
				allOk = false;
				console.error(CONSOLE_PREFIX + "Error fetching '" + originalUrl + "' (" + response.status + " " + response.statusText + ")");
			}
		}
		
		if (!allOk)
			throw new Error("not all resources were fetched successfully");
		
		// Can now assume all responses are OK. Open a cache and write all responses there.
		// ideally we can do this transactionally to ensure a complete cache is written as one atomic operation.
		// This needs either new transactional features in the spec, or at the very least a way to rename a cache
		// (so we can write to a temporary name that won't be returned by GetAvailableCacheNames() and then rename it when ready).
		return caches.open(cacheName)
		.then(cache =>
		{
			return Promise.all(responses.map(
				(response, i) => cache.put(fileList[i], response)
			));
		})
		.catch(err =>
		{
			// Not sure why cache.put() would fail (maybe if storage quota exceeded?) but in case it does,
			// clean up the cache to try to avoid leaving behind an incomplete cache.
			console.error(CONSOLE_PREFIX + "Error writing cache entries: ", err);
			caches.delete(cacheName);
			throw err;
		});
	});
};

function UpdateCheck(isFirst) {
    // Fetch offline data file
    return fetchWithBypass(OFFLINE_DATA_FILE, true)
        .then(r => r.json())
        .then(data => handleVersionCheck(data, isFirst))
        .catch(err => {
            // Log warnings for failed update check fetches (e.g. offline)
            console.warn(CONSOLE_PREFIX + "Update check failed: ", err);
        });
}

function handleVersionCheck(data, isFirst) {
    const version = data.version;
    let fileList = data.fileList;
    const currentCacheName = GetCacheVersionName(version);

    return caches.has(currentCacheName)
        .then(cacheExists => {
            if (cacheExists) {
                return handleExistingCache(version);
            }
            return handleNewCache(fileList, version, currentCacheName, isFirst);
        });
}

function handleExistingCache(version) {
    return IsUpdatePending()
        .then(isUpdatePending => {
            if (isUpdatePending) {
                console.log(CONSOLE_PREFIX + "Update pending");
                Broadcast("update-pending");
            } else {
                console.log(CONSOLE_PREFIX + "Up to date");
                Broadcast("up-to-date");
            }
        });
}

function handleNewCache(fileList, version, currentCacheName, isFirst) {
    return GetMainPageUrl()
        .then(mainPageUrl => {
            prepareFileList(fileList, mainPageUrl);
            console.log(CONSOLE_PREFIX + "Caching " + fileList.length + " files for offline use");

            if (isFirst) {
                Broadcast("downloading");
            } else {
                BroadcastDownloadingUpdate(version);
            }

            return cacheFiles(currentCacheName, fileList, !isFirst, version);
        });
}

function prepareFileList(fileList, mainPageUrl) {
    // Ensure the base URL ("/") and main page URL are included in the cache
    fileList.unshift("./");

    if (mainPageUrl && fileList.indexOf(mainPageUrl) === -1) {
        fileList.unshift(mainPageUrl);
    }
}

function cacheFiles(currentCacheName, fileList, bypassCache, version) {
    return CreateCacheFromFileList(currentCacheName, fileList, bypassCache)
        .then(IsUpdatePending)
        .then(isUpdatePending => {
            if (isUpdatePending) {
                console.log(CONSOLE_PREFIX + "All resources saved, update ready");
                BroadcastUpdateReady(version);
            } else {
                console.log(CONSOLE_PREFIX + "All resources saved, offline support ready");
                Broadcast("offline-ready");
            }
        });
}


self.addEventListener('install', event =>
{
	// On install kick off an update check to cache files on first use.
	// If it fails we can still complete the install event and leave the SW running, we'll just
	// retry on the next navigate.
	event.waitUntil(
		UpdateCheck(true)		// first update
		.catch(() => null)
	);
});

self.addEventListener('fetch', event => {
    const isNavigateRequest = (event.request.mode === "navigate");

    // Main fetch response promise
    let responsePromise = GetAvailableCacheNames()
        .then(availableCacheNames => handleAvailableCaches(event, availableCacheNames, isNavigateRequest));

    // If it's a navigation request, check for updates after the request completes
    if (isNavigateRequest) {
        event.waitUntil(responsePromise.then(() => UpdateCheck(false)));  // Not first check
    }

    event.respondWith(responsePromise);
});

// Handle available caches
function handleAvailableCaches(event, availableCacheNames, isNavigateRequest) {
    if (!availableCacheNames.length) {
        return fetch(event.request);
    }

    // Resolve the cache name to use
    return resolveCacheName(availableCacheNames, isNavigateRequest)
        .then(useCacheName => fetchFromCacheOrNetwork(event, useCacheName));
}

// Resolve which cache to use
function resolveCacheName(availableCacheNames, isNavigateRequest) {
    if (availableCacheNames.length === 1 || !isNavigateRequest) {
        return Promise.resolve(availableCacheNames[0]);
    }

    // Check clients to expire old caches if necessary
    return clients.matchAll()
        .then(clients => {
            if (clients.length > 1) {
                return availableCacheNames[0];  // Keep the oldest cache if more than one client is open
            }

            let latestCacheName = availableCacheNames[availableCacheNames.length - 1];
            console.log(CONSOLE_PREFIX + "Updating to new version");

            // Delete old caches and use the latest
            return deleteOldCaches(availableCacheNames).then(() => latestCacheName);
        });
}

// Delete old caches except the latest one
function deleteOldCaches(availableCacheNames) {
    const oldCaches = availableCacheNames.slice(0, -1);  // All but the latest
    return Promise.all(oldCaches.map(c => caches.delete(c)));
}

// Fetch from cache or network if not cached
function fetchFromCacheOrNetwork(event, useCacheName) {
    return caches.open(useCacheName)
        .then(cache => cache.match(event.request))
        .then(response => response || fetch(event.request));
}
