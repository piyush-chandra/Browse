import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirror of lib/env-blob.cjs (kept inline: route handlers can't cleanly
// require the CJS helper through the bundler).
function resolveBlobTokenKey(): string | null {
  if (process.env.BLOB_READ_WRITE_TOKEN) return "BLOB_READ_WRITE_TOKEN";
  return (
    Object.keys(process.env)
      .filter((k) => /^[A-Z0-9_]*_READ_WRITE_TOKEN$/.test(k) && process.env[k])
      .sort()[0] || null
  );
}

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
  // On Vercel, bare.ok === false means the deploy ran as plain Next.js
  // instead of building Dockerfile.vercel (custom server.js never started).
  // Call it out explicitly: the generic "use npm start" hint misleads here.
  const onVercel = process.env.VERCEL === "1";
  const bareHint = bare.ok
    ? undefined
    : onVercel
      ? "Running on Vercel WITHOUT the container: this deploy used plain Next.js, so custom server.js (/bare/) never started. Make sure Dockerfile.vercel is on the deployed branch (commit 84c5115+), then redeploy — the build logs should show a container/image build, not `next build`."
      : "Bare backend unreachable. Start with `npm run dev` / `npm start` (custom server.js), not plain `next dev`.";

  return NextResponse.json({
    ok,
    customServer: bare.ok,
    platform: {
      vercel: onVercel,
      vercelEnv: process.env.VERCEL_ENV || null,
    },
    assets: {
      ok: missingAssets.length === 0,
      missing: missingAssets,
      hint: missingAssets.length
        ? "Proxy files missing. Restart with `npm run dev` (or run `node scripts/setup-proxy-assets.mjs`)."
        : undefined,
    },
    bare: {
      ...bare,
      hint: bareHint,
    },
    remote: {
      ok: chrome !== null,
      chrome,
      hint: chrome ? undefined : "No Chrome/Chromium found. Set CHROME_PATH. /remote needs it; /browse does not.",
    },
    // Setup verification: without Blob, logins and the cookie vault reset
    // on every instance recycle (Vercel Hobby recycles aggressively) — the
    // classic "I logged in yesterday and it's gone" failure.
    persistence: {
      blob: resolveBlobTokenKey() !== null,
      blobTokenKey: resolveBlobTokenKey(),
      profileHttp: !!process.env.PROFILE_HTTP_URL,
      importToken: !!process.env.IMPORT_TOKEN,
      // Which persistence-related env KEYS the runtime actually sees (names
      // only, never values). Answers the classic misconfigurations at a
      // glance: store created but not connected to the project (no *_READ_WRITE_TOKEN
      // at all), connected with a custom prefix (e.g. BROWSE_BLOB_READ_WRITE_TOKEN
      // — the app only reads BLOB_READ_WRITE_TOKEN), or scoped to Preview
      // while this deployment is Production.
      envKeys: Object.keys(process.env)
        .filter((k) => /READ_WRITE_TOKEN|^BLOB|PROFILE_|^IMPORT_TOKEN$/i.test(k))
        .sort(),
      hint: resolveBlobTokenKey() === null && !process.env.PROFILE_HTTP_URL
        ? "No profile/vault persistence: the store must inject a *_READ_WRITE_TOKEN. In Vercel: Storage → browse-blob → copy the store's token (starts vercel_blob_rw_…) → Project Settings → Environment Variables → add BLOB_READ_WRITE_TOKEN (Production) → Redeploy. Creating the store alone injects nothing usable."
        : undefined,
    },
  });
}
