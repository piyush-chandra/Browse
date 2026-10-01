import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        // The Ultraviolet service worker must be allowed to control the whole
        // origin (it intercepts /service/<encoded-url> requests), and it must
        // never be served from cache or updates won't propagate.
        source: "/uv/sw.js",
        headers: [
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Cache-Control", value: "no-store, max-age=0" },
        ],
      },
      {
        // Proxy runtime files are copied from node_modules on every dev/build,
        // so always revalidate them.
        source: "/:dir(uv|baremux|baremod)/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
