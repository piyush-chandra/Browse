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
const next = require("next");
const { createBareServer } = require("@tomphttp/bare-server-node");

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

app.prepare().then(() => {
  const server = createServer((req, res) => {
    if (bare.shouldRoute(req)) {
      bare.routeRequest(req, res);
    } else {
      handle(req, res);
    }
  });

  server.on("upgrade", (req, socket, head) => {
    if (bare.shouldRoute(req)) {
      bare.routeUpgrade(req, socket, head);
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
