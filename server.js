// Custom Next.js server.
//
// This file is intentionally CommonJS: it runs directly under Node, outside
// the Next.js compiler, and the project is not "type": "module".
/* eslint-disable @typescript-eslint/no-require-imports */
//
// We need this because the Bare protocol (used by Ultraviolet) proxies both
// regular HTTP and WebSocket upgrades, and Next.js route handlers cannot
// handle raw socket upgrades. Everything under /bare/ is handled by the Bare
// server; everything else is handled by Next.js.
const { createServer } = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const next = require("next");
const { createBareServer } = require("@tomphttp/bare-server-node");
const { WebSocketServer } = require("ws");
const { RemoteManager } = require("./lib/remote-manager.cjs");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOST || "localhost";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

const bare = createBareServer("/bare/", {
  logErrors: true,
  // The default limiter allows only 10 keep-alive requests per IP per minute,
  // which a single proxied page blows through instantly (every subresource is
  // a request). Keep the limiter as a safety net but make it realistic.
  connectionLimiter: {
    maxConnectionsPerIP: 100000,
    windowDuration: 60,
    blockDuration: 5,
  },
});

function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": payload.byteLength,
  });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// POST /api/remote/session { sessionId?, url? } -> { sessionId, url, title }
// GET  /api/remote/session?id=...                -> describe | 404
// DELETE /api/remote/session?id=...              -> { ok }
async function handleRemoteSession(req, res, remote) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "POST") {
      const body = await readJson(req);
      const session = await remote.getOrCreate(body.sessionId, body.url);
      sendJson(res, 200, {
        sessionId: session.id,
        url: session.url,
        title: session.title,
      });
    } else if (req.method === "GET") {
      const info = remote.describe(url.searchParams.get("id"));
      if (!info) return sendJson(res, 404, { error: "no such session" });
      sendJson(res, 200, info);
    } else if (req.method === "DELETE") {
      const ok = await remote.close(url.searchParams.get("id"));
      sendJson(res, ok ? 200 : 404, { ok });
    } else {
      sendJson(res, 405, { error: "method not allowed" });
    }
  } catch (err) {
    console.error("[remote] session error:", err.message);
    sendJson(res, 500, { error: err.message });
  }
}

// GET /api/remote/cookies?id=...&url=... -> { cookies: [...] }
// Exposes the real browser's cookies (e.g. after an OAuth login) so they can
// be inspected or, in future, handed to the fast proxy.
async function handleRemoteCookies(req, res, remote) {
  try {
    const url = new URL(req.url, "http://localhost");
    const cookies = await remote.getCookies(
      url.searchParams.get("id"),
      url.searchParams.get("url") || undefined
    );
    sendJson(res, 200, { cookies });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

// The proxy runtime lives in public/ and is committed, but a fresh/partial
// checkout (or a deleted folder) can still miss files. Self-heal on boot so
// the app never serves a half-working proxy with cryptic 404s.
function ensureProxyAssets() {
  const required = [
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
  const missing = required.filter(
    (f) => !fs.existsSync(path.join(__dirname, "public", f))
  );
  if (missing.length === 0) {
    console.log(`[browse] proxy assets OK (${required.length} files)`);
    return;
  }
  console.log(`[browse] proxy assets missing: ${missing.join(", ")}`);
  console.log("[browse] regenerating via scripts/setup-proxy-assets.mjs …");
  try {
    execSync("node scripts/setup-proxy-assets.mjs", {
      cwd: __dirname,
      stdio: "inherit",
    });
    console.log("[browse] proxy assets regenerated");
  } catch {
    console.error(
      "[browse] FAILED to regenerate proxy assets. Run manually: node scripts/setup-proxy-assets.mjs"
    );
  }
}

ensureProxyAssets();

app.prepare().then(() => {
  const remote = new RemoteManager();
  const remoteWss = new WebSocketServer({ noServer: true });

  const server = createServer((req, res) => {
    if (bare.shouldRoute(req)) {
      bare.routeRequest(req, res);
      return;
    }
    // Real-browser session API (see lib/remote-manager.cjs). Kept here
    // instead of a Next route so it shares the single browser manager.
    if (req.url === "/api/remote/session" || req.url.startsWith("/api/remote/session?")) {
      handleRemoteSession(req, res, remote);
      return;
    }
    if (req.url.startsWith("/api/remote/cookies")) {
      handleRemoteCookies(req, res, remote);
      return;
    }
    handle(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    if (bare.shouldRoute(req)) {
      bare.routeUpgrade(req, socket, head);
      return;
    }
    if (req.url === "/remote-ws" || req.url.startsWith("/remote-ws?")) {
      const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId");
      remoteWss.handleUpgrade(req, socket, head, (ws) => {
        remote.handleConnection(ws, sessionId);
      });
      return;
    }
    // Non-bare upgrades (e.g. Next.js HMR in development) are handled by
    // Next's own upgrade listener, which it attaches automatically on the
    // first request. Deliberately do nothing here so we don't consume the
    // socket before Next sees it.
  });

  server.on("error", (err) => {
    console.error(err);
    process.exit(1);
  });

  server.listen(port, hostname, () => {
    console.log(
      `> Browse ready on http://${hostname}:${port} (${dev ? "development" : "production"})`
    );
  });

  const shutdown = () => {
    bare.close();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
});
