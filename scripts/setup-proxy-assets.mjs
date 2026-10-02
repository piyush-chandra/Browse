// Copies the proxy runtime (Ultraviolet, bare-mux, bare-as-module3) from
// node_modules into public/ so Next.js can serve them as static assets.
//
// Run automatically via the predev/prebuild/postinstall npm scripts.
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nm = path.join(root, "node_modules");
const pub = path.join(root, "public");

const assets = [
  // Ultraviolet client + service worker runtime
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.bundle.js", "uv/uv.bundle.js"],
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.client.js", "uv/uv.client.js"],
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.handler.js", "uv/uv.handler.js"],
  ["@titaniumnetwork-dev/ultraviolet/dist/uv.sw.js", "uv/uv.sw.js"],
  // bare-mux: transport manager used by both the page and the service worker
  ["@mercuryworkshop/bare-mux/dist/index.js", "baremux/index.js"],
  ["@mercuryworkshop/bare-mux/dist/worker.js", "baremux/worker.js"],
  // Bare protocol v3 client transport (talks to our /bare/ server)
  ["@mercuryworkshop/bare-as-module3/dist/index.mjs", "baremod/index.mjs"],
];

for (const [from, to] of assets) {
  const src = path.join(nm, from);
  const dest = path.join(pub, to);
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(src, dest);
}

// Ultraviolet config. Paths are absolute so the bundle can be loaded from both
// the top-level page and the service worker.
await writeFile(
  path.join(pub, "uv", "uv.config.js"),
  `/* global Ultraviolet */
self.__uv$config = {
  prefix: "/service/",
  encodeUrl: Ultraviolet.codec.xor.encode,
  decodeUrl: Ultraviolet.codec.xor.decode,
  handler: "/uv/uv.handler.js",
  client: "/uv/uv.client.js",
  bundle: "/uv/uv.bundle.js",
  config: "/uv/uv.config.js",
  sw: "/uv/uv.sw.js",
};
`
);

// Service worker entry. Only intercepts Ultraviolet-prefixed requests so it
// never interferes with the Next.js app itself.
await writeFile(
  path.join(pub, "uv", "sw.js"),
  `/* global UVServiceWorker, __uv$config */
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
`
);

console.log(`[setup-proxy-assets] copied ${assets.length} proxy runtime files into public/`);
