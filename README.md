# Browse

A web-proxy browser: enter any URL and browse the site inside this app, with working navigation, logins, media streaming, and WebSockets.

## How it works

Instead of fetching pages server-side and rewriting HTML by hand, Browse uses the same architecture as established web proxies (Holy Unblocker, Nebula):

- **Ultraviolet** (`@titaniumnetwork-dev/ultraviolet`) — a service worker (`/uv/sw.js`, root scope) intercepts every request to `/service/<encoded-url>`, decodes the target URL, rewrites HTML/CSS/JS, cookies, workers, and media URLs on the fly.
- **bare-mux** (`@mercuryworkshop/bare-mux`) — manages the transport between the page, the service worker, and the proxy server via a SharedWorker (`/baremux/worker.js`).
- **Bare server** (`@tomphttp/bare-server-node`, Bare protocol v3) — mounted at `/bare/` inside the custom Node server. It performs the actual upstream HTTP requests (including `Range` streaming) and WebSocket upgrades, with its own cookie handling per the Bare spec.

The Next.js UI (`/` home, `/browse` viewer with toolbar) only handles the address bar, navigation, and booting the proxy client.

## Getting started

Requires Node.js 18+.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). This starts a **custom server** (`server.js`), not `next dev` — the custom server is required so WebSocket upgrades (`/bare/`) reach the Bare server. HMR and all Next.js features keep working.

For production:

```bash
npm run build
npm start
```

The proxy runtime files (`public/uv/`, `public/baremux/`, `public/baremod/`) are copied from `node_modules` automatically on install/dev/build by `scripts/setup-proxy-assets.mjs`.

## Testing

`scripts/verify-proxy.mjs` loads a target URL headlessly (requires Google Chrome) and reports what renders inside the proxied frame:

```bash
node scripts/verify-proxy.mjs https://example.com/
```

## What works / known limits

- Most sites render and navigate correctly, including multi-page flows, forms, images, fonts, and file downloads.
- Cookie-based logins work (handled by Ultraviolet's cookie jar + the Bare server), e.g. the GitHub sign-in page loads and submits.
- Plain `<video>`/`<audio>` streaming works, including seeking (`Range` requests are forwarded).
- Sites using WebSockets work (the Bare server handles `Upgrade`).
- **YouTube pages render** (watch page, search, recommendations) but **video playback is blocked by YouTube itself**: `googlevideo.com` returns `403 Forbidden` for media segments even for direct requests from this network (verified with `curl`, outside the proxy). No fetch-based proxy can fix that from a flagged network — it needs either a clean egress IP or a real remote browser (see below).
- Logins that use aggressive bot detection (Google, banks) may refuse proxied sessions. Same reason as above.

If you need guaranteed fidelity for those cases, the alternative is a real headless Chromium per session streamed to the client (Playwright + screencast/WebRTC), which is a different, heavier architecture.
