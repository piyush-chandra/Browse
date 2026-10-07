import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirror of lib/env-blob.cjs (kept inline: route handlers can't cleanly
// require the CJS helper through the bundler).
function findEnvKey(re: RegExp): string | null {
  return (
    Object.keys(process.env)
      .filter((k) => re.test(k) && process.env[k])
      .sort()[0] || null
  );
}
function resolveBlobTokenKey(): string | null {
  if (process.env.BLOB_READ_WRITE_TOKEN) return "BLOB_READ_WRITE_TOKEN";
  return findEnvKey(/^[A-Z0-9_]*_READ_WRITE_TOKEN$/);
}
function resolveBlobStoreKey(): string | null {
  if (process.env.BLOB_STORE_ID) return "BLOB_STORE_ID";
  return findEnvKey(/^[A-Z0-9_]*_STORE_ID$/);
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
    // Feature flags for deploy correlation: Docker builds don't get
    // VERCEL_GIT_COMMIT_SHA, so a timestamp can't tell you WHICH commit is
    // live. Extend this list when landing behavioral changes.
    features: ["vault-refresh", "import-token-ui", "oidc-blob", "legacy-sw-purge", "remote-diag", "attach-hardening", "oauth-safe-steer", "remote-diagnose-btn", "no-silent-stream", "throttled-snapshots", "first-paint-guarantee"],
    deploy: {
      // NEXT_PUBLIC_ASSET_V is the git SHA on Vercel builds (see
      // next.config.ts). If this doesn't match the commit you pushed,
      // you're hitting an older deployment — redeploy.
      assetV: process.env.NEXT_PUBLIC_ASSET_V || null,
      vercelEnv: process.env.VERCEL_ENV || null,
    },
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
      // "token": static read/write token present. "oidc": no static token,
      // but a store id is present — the SDK mints credentials at call time
      // from VERCEL_OIDC_TOKEN (automatic on Vercel). No dashboard token
      // hunt needed in that case.
      blob: resolveBlobTokenKey() !== null || resolveBlobStoreKey() !== null,
      blobMode:
        resolveBlobTokenKey() !== null
          ? "token"
          : resolveBlobStoreKey() !== null
            ? "oidc"
            : null,
      blobTokenKey: resolveBlobTokenKey(),
      blobStoreKey: resolveBlobStoreKey(),
      profileHttp: !!process.env.PROFILE_HTTP_URL,
      importToken: !!process.env.IMPORT_TOKEN,
      // Which persistence-related env KEYS the runtime actually sees (names
      // only, never values).
      envKeys: Object.keys(process.env)
        .filter((k) => /READ_WRITE_TOKEN|^BLOB|PROFILE_|^IMPORT_TOKEN$|_STORE_ID$/i.test(k))
        .sort(),
      hint:
        resolveBlobTokenKey() === null &&
        resolveBlobStoreKey() === null &&
        !process.env.PROFILE_HTTP_URL
          ? "No profile/vault persistence: connect a Blob store to THIS project (Storage → browse-blob → Connect, Production) and REDEPLOY. A store id alone (OIDC mode) also works — no token copy needed."
          : undefined,
    },
  });
}
