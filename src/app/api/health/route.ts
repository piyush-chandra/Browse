import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROXY_ASSETS = [
  "uv/uv.bundle.js",
  "uv/uv.client.js",
  "uv/uv.handler.js",
  "uv/uv.sw.js",
  "uv/uv.config.js",
  "uv/sw.js",
  "baremux/index.js",
  "baremux/worker.js",
  "baremod/index.mjs",
];

function findChrome(): string | null {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (fs.existsSync(mac)) return mac;
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const found = execSync(`which ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (found) return found;
    } catch {
      // try next
    }
  }
  return null;
}

// GET /api/health -> { ok, assets, bare, customServer, chrome }
// The single place to look when "nothing loads": every failure mode the UI
// can hit is reported here with an actionable hint.
export async function GET(req: NextRequest) {
  const publicDir = path.join(process.cwd(), "public");
  const missingAssets = PROXY_ASSETS.filter((f) => !fs.existsSync(path.join(publicDir, f)));

  // The Bare server only exists on the custom server (server.js). If this
  // fetch fails, the app was started with plain `next dev`/`next start`.
  // Probe the loopback interface on our own listening port first: behind a
  // reverse proxy or in a container (Vercel Dockerfile.vercel, Docker, Fly)
  // the public origin's port is not our local port (Vercel injects $PORT,
  // default 80, and terminates TLS at the edge), so `origin` alone can miss.
  // Fall back to the request origin (covers HOST=localhost dev, where the
  // URL port is the real one). 127.0.0.1 avoids localhost IPv6/IPv4 mismatch.
  let bare: { ok: boolean; versions?: string[]; error?: string } = { ok: false };
  const origin = new URL(req.url).origin;
  const urlPort = new URL(req.url).port;
  const localPort = process.env.PORT || urlPort || "3000";
  const candidates = [`http://127.0.0.1:${localPort}`, origin].filter(
    (v, i, a) => v && a.indexOf(v) === i
  );
  let lastError = "unreachable";
  for (const base of candidates) {
    try {
      const res = await fetch(`${base}/bare/`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const manifest = (await res.json()) as { versions?: string[] };
        bare = { ok: true, versions: manifest.versions };
        break;
      }
      lastError = `HTTP ${res.status} via ${base}`;
    } catch (err) {
      lastError = `${err instanceof Error ? err.message : String(err)} via ${base}`;
    }
  }
  if (!bare.ok) {
    bare = {
      ok: false,
      error: lastError,
    };
  }

  const chrome = findChrome();
  const ok = missingAssets.length === 0 && bare.ok;

  return NextResponse.json({
    ok,
    customServer: bare.ok,
    assets: {
      ok: missingAssets.length === 0,
      missing: missingAssets,
      hint: missingAssets.length
        ? "Proxy files missing. Restart with `npm run dev` (or run `node scripts/setup-proxy-assets.mjs`)."
        : undefined,
    },
    bare: {
      ...bare,
      hint: bare.ok
        ? undefined
        : "Bare backend unreachable. Start with `npm run dev` / `npm start` (custom server.js), not plain `next dev`.",
    },
    remote: {
      ok: chrome !== null,
      chrome,
      hint: chrome ? undefined : "No Chrome/Chromium found. Set CHROME_PATH. /remote needs it; /browse does not.",
    },
  });
}
