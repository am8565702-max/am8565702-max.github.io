var CACHE_NAME = "olive-branch-menu-v45";
var STATIC_FILES = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./order-receipt.js?v=7-performance-fix",
  "./leaflet.css?v=1.9.4",
  "./leaflet.js?v=1.9.4",
  "./menu-enhancements.css?v=9-saved-addresses",
  "./menu-enhancements.js?v=15-mobile-refresh"
];

function cacheFreshFiles(cache) {
  return Promise.all(STATIC_FILES.map(function (url) {
    return fetch(url, { cache: "no-store" }).then(function (response) {
      if (!response || !response.ok) throw new Error("CACHE_FETCH_FAILED: " + url);
      return cache.put(url, response.clone());
    });
  }));
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cacheFreshFiles(cache);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (key) {
        return key !== CACHE_NAME;
      }).map(function (key) {
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    }).then(function () {
      return self.clients.matchAll({ type: "window", includeUncontrolled: true });
    }).then(function (clients) {
      var visibleClient = null;
      var fallbackClient = null;
      clients.forEach(function (client) {
        if (!client || typeof client.navigate !== "function") return;
        var clientUrl = new URL(client.url);
        if (clientUrl.origin !== self.location.origin) return;
        if (!fallbackClient) fallbackClient = client;
        if (!visibleClient && client.visibilityState === "visible") visibleClient = client;
      });
      var targetClient = visibleClient || fallbackClient;
      return targetClient ? targetClient.navigate(targetClient.url) : null;
    })
  );
});

self.addEventListener("fetch", function (event) {
  if (event.request.method !== "GET") return;
  var requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).then(function (response) {
        var copy = response.clone();
        caches.open(CACHE_NAME).then(function (cache) {
          cache.put("./index.html", copy);
        });
        return response;
      }).catch(function () {
        return caches.match("./index.html");
      })
    );
    return;
  }

  if (event.request.destination === "script" || event.request.destination === "style" ||
      /\.(?:js|css)(?:$|\?)/.test(requestUrl.href)) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      }).catch(function () {
        return caches.match(event.request);
      })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(function (cached) {
      if (cached) return cached;
      return fetch(event.request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, copy);
          });
        }
        return response;
      });
    })
  );
});
