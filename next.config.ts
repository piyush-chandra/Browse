import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  env: {
    // Inlined into client bundles at build time; used to cache-bust the
    // proxy runtime assets (see src/lib/proxy-boot.ts). Vercel provides
    // VERCEL_GIT_COMMIT_SHA; local builds fall back to the build timestamp.
    NEXT_PUBLIC_ASSET_V:
      process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 8) || String(Date.now()),
  },
  async headers() {
    // NOTE on ordering: when several rules match one path, the LAST rule
    // wins for a repeated header key (verified live: the generic pattern
    // below used to shadow /uv/sw.js's no-store). So the service-worker
    // rule stays last.
    return [
      {
        // Proxy runtime files are copied from node_modules on every dev/build,
        // so always revalidate them.
        source: "/:dir(baremux|baremod)/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
      {
        // Same for the Ultraviolet client files (bundle/handler/config).
        source: "/uv/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
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
    ];
  },
};

export default nextConfig;
