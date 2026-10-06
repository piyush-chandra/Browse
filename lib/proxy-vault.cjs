// Cookie vault for the fast proxy.
//
// The fast proxy (Ultraviolet + Bare) can't do Google/OAuth sign-ins, but
// once the real browser (/remote, session "google") is logged in, its
// cookies for a site (e.g. neetcode.io) can be vaulted here and injected
// server-side into every /bare/ request for that origin. This makes the
// FAST proxy browse logged-in without ever touching the login flow.
//
// Why server-side: session cookies are usually httpOnly — document.cookie
// (the client-side path) cannot set them. Injecting into x-bare-headers
// before bare.routeRequest works because bare-server-node constructs its
// Request from the live req.headers object at call time (verified in
// BareServer.js).
//
// Persistence: stored as proxy-vault.json in Vercel Blob when
// BLOB_READ_WRITE_TOKEN is set, so the vault survives restarts/scale-in.
// Otherwise in-memory only.
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");

const VAULT_KEY = "proxy-vault.json";
// Disk fallback for single-instance hosts (Blob is the Vercel path).
const DISK_PATH = path.join(process.cwd(), "data", VAULT_KEY);
const vault = new Map(); // host -> cookie header string
let loaded = false;

function blobEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

let blobLib = null;
function getBlob() {
  if (blobLib) return blobLib;
  blobLib = require("@vercel/blob");
  return blobLib;
}

async function fetchBlobVault() {
  const blob = getBlob();
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  const listing = await blob.list({ prefix: VAULT_KEY, token });
  const hit = (listing.blobs || []).find((b) => b.pathname === VAULT_KEY);
  if (!hit) return null;
  let res;
  try {
    res = await blob.download(hit.url, { token });
  } catch {
    res = await fetch(hit.url);
  }
  return JSON.parse(await res.text());
}

function applyData(data) {
  for (const [host, cookie] of Object.entries(data)) {
    vault.set(String(host), String(cookie));
  }
}

async function blobSave() {
  if (blobEnabled()) {
    try {
      const blob = getBlob();
      const data = Object.fromEntries(vault);
      await blob.put(VAULT_KEY, JSON.stringify(data), {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/json",
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
      return;
    } catch (err) {
      console.warn(`[vault] blob save failed: ${err.message}`);
    }
  }
  // Disk fallback (persistent hosts / local dev).
  try {
    fs.mkdirSync(path.dirname(DISK_PATH), { recursive: true });
    fs.writeFileSync(DISK_PATH, JSON.stringify(Object.fromEntries(vault), null, 2));
  } catch {}
}

async function load() {
  if (loaded) return;
  loaded = true;
  if (blobEnabled()) {
    try {
      const data = await fetchBlobVault();
      if (data) {
        applyData(data);
        console.log(`[vault] loaded ${vault.size} origin(s) from blob storage`);
        return;
      }
    } catch (err) {
      console.warn(`[vault] blob load failed: ${err.message}`);
    }
  }
  try {
    if (fs.existsSync(DISK_PATH)) {
      const data = JSON.parse(fs.readFileSync(DISK_PATH, "utf-8"));
      for (const [host, cookie] of Object.entries(data)) {
        vault.set(String(host), String(cookie));
      }
      console.log(`[vault] loaded ${vault.size} origin(s) from disk`);
    }
  } catch (err) {
    console.warn(`[vault] disk load failed: ${err.message}`);
  }
}

// Build a Cookie header from the remote session's cookies for `url`.
function cookiesToHeader(cookies, host) {
  const hostClean = String(host || "").toLowerCase().replace(/^www\./, "");
  const nowSec = Date.now() / 1000;
  const matching = (cookies || []).filter((c) => {
    if (c.expires && c.expires > 0 && c.expires < nowSec) return false; // expired
    const d = String(c.domain || "").toLowerCase().replace(/^\./, "");
    return d && (hostClean === d || hostClean.endsWith("." + d));
  });
  return matching.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Merge client-provided Cookie (fresh UV jar) with the vault value.
// Client values win on name collisions (fresher — they came from the
// site's own responses); the vault only fills names the client lacks.
// (Apply vault FIRST so the client's later entries override it.)
function mergeCookieHeaders(vaulted, client) {
  const out = new Map();
  for (const part of (vaulted || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  for (const part of (client || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return [...out].map(([k, v]) => `${k}=${v}`).join("; ");
}

// Cross-instance consistency: the instance holding the real-browser login
// (WS-pinned) is rarely the instance serving a given /bare/ request, and
// load() only runs at boot — so a login vaulted seconds ago used to stay
// invisible here until restart. On a miss, re-pull the shared vault from
// Blob (throttled; fire-and-forget so requests never block on it).
const REFRESH_TTL_MS = 30000;
let lastRefreshAt = 0;
let refreshInflight = null;

function refresh() {
  if (!blobEnabled()) return Promise.resolve();
  if (refreshInflight) return refreshInflight;
  lastRefreshAt = Date.now();
  refreshInflight = (async () => {
    try {
      const data = await fetchBlobVault();
      if (data) {
        // Wholesale replace: deletions on other instances propagate too.
        vault.clear();
        applyData(data);
      }
    } catch (err) {
      console.warn(`[vault] blob refresh failed: ${err.message}`);
    } finally {
      refreshInflight = null;
    }
  })();
  return refreshInflight;
}

// Mutate req.headers so bare-server-node forwards the vaulted cookies.
// Best-effort: any failure just means the request goes out as-is.
function inject(req) {
  try {
    const bareUrl = req.headers["x-bare-url"];
    if (!bareUrl) return;
    let target;
    try {
      target = new URL(bareUrl);
    } catch {
      return;
    }
    const host = target.hostname.toLowerCase().replace(/^www\./, "");
    const vaulted = vault.get(host);
    if (!vaulted) {
      if (Date.now() - lastRefreshAt > REFRESH_TTL_MS) {
        refresh().catch(() => {});
      }
      return;
    }

    let headers = {};
    const raw = req.headers["x-bare-headers"];
    if (raw) {
      try {
        headers = JSON.parse(raw);
      } catch {
        return; // malformed client headers — don't corrupt the request
      }
    }
    const existing = headers.cookie || headers.Cookie || "";
    headers.cookie = mergeCookieHeaders(vaulted, existing);
    delete headers.Cookie;
    req.headers["x-bare-headers"] = JSON.stringify(headers);
  } catch {
    // never break proxied traffic
  }
}

function set(host, cookieHeader) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!h || !cookieHeader) return false;
  vault.set(h, String(cookieHeader));
  blobSave().catch(() => {});
  return true;
}

function remove(host) {
  const h = String(host || "").toLowerCase().replace(/^www\./, "");
  const existed = vault.delete(h);
  blobSave().catch(() => {});
  return existed;
}

function list() {
  return [...vault.keys()];
}

module.exports = { inject, set, remove, list, load, refresh, cookiesToHeader, blobEnabled };
