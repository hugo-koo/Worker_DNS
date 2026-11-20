/**
 * sw.ts - Service Worker Entry & Event Router (TypeScript)
 *
 * This file orchestrates the Service Worker lifecycle and routes events
 * to appropriate domain-specific sub-services (like sw-icon-cache.ts).
 */

import {
  isIconRequest,
  handleIconFetch,
  handleIconPrefetch,
  cleanExpiredCache,
  cleanOldCaches,
} from "./sw-icon-cache.ts";
import {
  isLogDetailRequest,
  handleLogDetailFetch,
  cleanExpiredLogCache,
  purgeLogsCache,
} from "./sw-log-cache.ts";
// TypeScript declaration for Service Worker global scope
declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
  __dnsWorkerManifest?: Array<{ url: string; revision: string | null }>;
};

// Retain the Workbox manifest placeholder against bundler dead-code elimination
self.__dnsWorkerManifest = self.__WB_MANIFEST;

self.addEventListener("install", () => {
  self.skipWaiting();
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      cleanExpiredCache(),
      cleanOldCaches(),
      cleanExpiredLogCache()
    ])
  );
});

// Router for fetch requests
self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Intercept DuckDuckGo icon requests
  if (isIconRequest(url)) {
    event.respondWith(handleIconFetch(event));
  }

  // Intercept Log Detail API requests
  if (isLogDetailRequest(url)) {
    event.respondWith(handleLogDetailFetch(event));
  }
});

// Router for cross-thread messages
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "PREFETCH_ICONS") {
    handleIconPrefetch(event.data.domains);
  } else if (event.data && event.data.type === "PURGE_LOGS_CACHE") {
    event.waitUntil(purgeLogsCache());
  }
});
