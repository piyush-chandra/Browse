/* global UVServiceWorker, __uv$config */
importScripts("uv.bundle.js");
importScripts("uv.config.js");
importScripts(__uv$config.sw || "uv.sw.js");

const uv = new UVServiceWorker();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  if (uv.route(event)) {
    event.respondWith(
      uv.fetch(event).then((res) => {
        // UV adds a Content-Disposition inline filename header to document
        // responses. For top-level audio/video navigations that header can
        // confuse the media stack, so strip it for media types (the body
        // and all other headers pass through untouched).
        const ct = res.headers.get("content-type") || "";
        const isMedia = ct.indexOf("audio/") === 0 || ct.indexOf("video/") === 0;
        if (isMedia && res.headers.has("content-disposition")) {
          const headers = new Headers(res.headers);
          headers.delete("content-disposition");
          return new Response(res.body, {
            status: res.status,
            statusText: res.statusText,
            headers,
          });
        }
        return res;
      })
    );
  }
});
