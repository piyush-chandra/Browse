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

`scripts/verify-remote.mjs` does the same for a real-browser session (frames, nav events, viewer screenshot):

```bash
node scripts/verify-remote.mjs https://neetcode.io/
```

## Two browsing modes

- **Fast proxy** (`/browse`) — Ultraviolet + Bare server. Quick, handles most sites, media streaming, and ordinary cookie logins. Cannot do third-party OAuth (Google/GitHub "Login with…") because the `redirect_uri` would be the proxy origin, which providers reject — and aggressive bot checks may refuse proxied sessions.
- **Real browser** (`/remote`) — a real Chromium on the server, streamed to your tab via CDP screencast with mouse/keyboard forwarding. Use it for Google/GitHub logins (e.g. NeetCode Sign In → GitHub/Google both reach the genuine provider pages), captchas, and anything the proxy can't do. Sessions persist in `./data/remote/<id>` (default `main`), so you stay logged in across visits; idle browsers are reaped automatically. From any `/browse` page, the **Real browser** button hands the current URL over.

Stealth notes (`lib/remote-manager.cjs`): `--enable-automation` removed, `--headless=new`, `navigator.webdriver` hidden, plus env overrides `CHROME_PATH` and `REMOTE_HEADLESS=false` (headed, if a provider ever demands it).

## What works / known limits

- Most sites render and navigate correctly, including multi-page flows, forms, images, fonts, and file downloads.
- Cookie-based logins work (handled by Ultraviolet's cookie jar + the Bare server), e.g. the GitHub sign-in page loads and submits.
- Plain `<video>`/`<audio>` streaming works, including seeking (`Range` requests are forwarded).
- Sites using WebSockets work (the Bare server handles `Upgrade`).
- **YouTube pages render** (watch page, search, recommendations) but **video playback is blocked by YouTube itself**: `googlevideo.com` returns `403 Forbidden` for media segments even for direct requests from this network (verified with `curl`, outside the proxy). No fetch-based proxy can fix that from a flagged network — it needs either a clean egress IP or a real remote browser (see below).
- Logins that use aggressive bot detection (Google, banks) may refuse proxied sessions. Same reason as above.

If you need guaranteed fidelity for those cases, the alternative is a real headless Chromium per session streamed to the client (Playwright + screencast/WebRTC), which is a different, heavier architecture.

## Deployment — read this before using Vercel

**Vercel (and Netlify serverless) cannot host this app.** They run short-lived functions, but Browse needs a long-lived Node process for three things:

- the custom `server.js` (Bare backend at `/bare/` + remote-browser API),
- WebSocket upgrades (`/bare/` media/chat, `/remote-ws` screencast) — serverless has no raw socket upgrades,
- a real Chrome for `/remote` sessions.

On Vercel you will get exactly `Bare backend unreachable` from `/api/health` — that is the app correctly telling you the backend isn't there. Deploy instead on any host that runs `npm start` as a persistent process with WebSocket support:

| Host | How | Remote browser? |
|---|---|---|
| Railway | New project → Deploy from repo. It auto-detects Node (`npm run build` / `npm start`). | No Chrome on native Node — fast proxy only. Use Docker deploy for full. |
| Render | New Web Service → Docker (uses the included `Dockerfile`). | Yes (Chrome baked in). |
| Fly.io | `fly launch` (detects the `Dockerfile`). | Yes. |
| Any VPS | `git clone`, `npm ci`, `npm run build`, `HOST=0.0.0.0 npm start` (+ install Chrome for `/remote`). | Yes, if Chrome installed. |

The included `Dockerfile` (Node 20 + Google Chrome, `npm ci` → build → `npm start` on `0.0.0.0:3000`) is the fully-working option. Note: browser profiles live in `./data/remote/` (ephemeral disk = logins reset on redeploy; mount a volume to keep them).

Required env: `HOST=0.0.0.0` inside containers (default `localhost` only binds loopback). Optional: `PORT`, `CHROME_PATH` (defaults to system Chrome), `REMOTE_HEADLESS=false` (headed).
