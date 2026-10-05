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
- **YouTube pages render** (watch page, search, recommendations) but **video playback is blocked by YouTube itself**: `googlevideo.com` returns `403 Forbidden` for media segments even for direct requests from this network (verified with `curl`, outside the proxy). No fetch-based proxy can fix that from a flagged network — it needs either a clean egress IP or a real remote browser. The `/browse` viewer shows a banner on YouTube pages with a one-click **Open in Real browser** handoff for this reason.
- Logins that use aggressive bot detection (Google, banks) may refuse proxied sessions. Same reason as above.

If you need guaranteed fidelity for those cases, the alternative is a real headless Chromium per session streamed to the client (Playwright + screencast/WebRTC), which is a different, heavier architecture.

## Deployment — Vercel now works via `Dockerfile.vercel`

**Netlify serverless still cannot host this app** (short-lived functions, no
custom server, no raw WebSocket upgrades, no Chrome).

**Vercel works via ["Bring your Dockerfile to Vercel
Functions"](https://vercel.com/changelog/bring-your-dockerfile-to-vercel-functions)**
([docs](https://vercel.com/docs/functions/container-images)): Vercel Functions
now run OCI container images on Fluid compute. This repo ships a
`Dockerfile.vercel` at the root — Vercel auto-detects it, builds the image,
pushes it to Vercel Container Registry, and routes all traffic to the
container on every commit. No `vercel.json` needed.

```bash
# after pushing to GitHub:
vercel          # preview deploy, or import the repo in the Vercel dashboard
vercel --prod   # production deploy
```

No env vars are required: the image binds `0.0.0.0` and respects Vercel's
injected `$PORT` (default 80). `npm start` (`server.js`: `/bare/` backend +
`/remote-ws` screencast + Next.js) runs as the container's HTTP server and
handles `SIGTERM` on scale-in.

Vercel caveats (same [limits](https://vercel.com/docs/functions/limitations)
as Vercel Functions):

- **Scale to zero**: idle instances stop after ~5 min (prod) / ~30s (preview).
  The fast proxy (`/browse`) is unaffected — each proxied request is
  short-lived. Long `/remote-ws` screencast streams can be cut (max duration
  300s Hobby, up to 800s Pro/Enterprise).
- **Ephemeral disk**: `./data/remote/` browser profiles vanish on scale-in /
  redeploy, so `/remote` logins don't persist on Vercel. Use it for one-off
  logins/bot checks, not persistent sessions.
- **Cold starts**: the Chrome layer makes the image ~1.5GB. For a smaller /
  faster-booting image with fast-proxy only, delete the Chrome install block
  in `Dockerfile.vercel` — then `/remote` reports "No Chrome found" while
  `/browse` keeps working.
- **Memory**: Chrome + Next fits in Hobby's 2 GB but is happier on Pro's
  4 GB if you use `/remote` heavily.
- No Secure Compute / Static IPs for container images yet — `googlevideo.com`
  403s from a flagged egress network apply here too (see limits below).
- Test locally with `vercel dev` (needs the `docker` CLI + daemon).

Other hosts that run `npm start` as a persistent process:

| Host | How | Remote browser? |
|---|---|---|
| Vercel | Import repo (or `vercel --prod`). Uses `Dockerfile.vercel` automatically. | Yes, but ephemeral (profiles reset; streams capped by max duration). |
| Railway | New project → Deploy from repo. It auto-detects Node (`npm run build` / `npm start`). | No Chrome on native Node — fast proxy only. Use Docker deploy for full. |
| Render | New Web Service → Docker (uses the included `Dockerfile`). | Yes (Chrome baked in). |
| Fly.io | `fly launch` (detects the `Dockerfile`). | Yes. |
| Any VPS | `git clone`, `npm ci`, `npm run build`, `HOST=0.0.0.0 npm start` (+ install Chrome for `/remote`). | Yes, if Chrome installed. |

The included `Dockerfile` (Node 20 + Google Chrome, `npm ci` → build → `npm start` on `0.0.0.0:3000`) is the fully-working option. Note: browser profiles live in `./data/remote/` (ephemeral disk = logins reset on redeploy; mount a volume to keep them).

Required env: `HOST=0.0.0.0` inside containers (default `localhost` only binds loopback). Optional: `PORT`, `CHROME_PATH` (defaults to system Chrome), `REMOTE_HEADLESS=false` (headed).

## Staying logged in (Google & co)

Google sign-in cannot complete in the fast proxy (provider-level bot checks; see limits above) — `/browse` shows a banner and a one-click **Sign in with Google** button that hands the site to the real browser instead. The real browser (`/remote`) *can* do Google logins; to make them **persist** (log in once, stay logged in across restarts and Vercel scale-in), configure external profile storage:

1. In Vercel: Project → **Storage** → create **Blob** → connect to the project (injects `BLOB_READ_WRITE_TOKEN`). Push/redeploy — done.
2. On any other host: set `PROFILE_HTTP_URL` (must contain `{id}`) plus optional `PROFILE_HTTP_TOKEN`.
3. Nothing to set? Profiles persist on the host's local disk (`./data/remote/<id>`) — fine on Railway/Render/Fly/VPS, wiped on Vercel.

Snapshots fire after every navigation, on session close, and on SIGTERM (Vercel gives ~30s grace on scale-in). Only the useful subset of the Chrome profile is uploaded (cookies, local/indexed storage, prefs — **not** saved passwords unless `PROFILE_KEEP_LOGINS=1`), pruned and size-capped (`PROFILE_MAX_MB`, default 25 MB). Manage via `GET/POST/DELETE /api/remote/profile`. `/remote` shows the active mode in its toolbar (`profile: vercel-blob` vs `profile: local`).
