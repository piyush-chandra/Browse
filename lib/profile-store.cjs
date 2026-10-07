// Optional external persistence for remote-browser Chrome profiles.
//
// Why: on Vercel (container Functions) the disk is ephemeral — Chrome
// profiles under ./data/remote/<id> vanish on redeploy/scale-in, so Google
// (or any) logins don't survive. On a real host they already persist to
// disk. This layer snapshots the *useful* part of a profile (cookies,
// local storage, IndexedDB, preferences) to external storage after
// sessions and restores it before the next launch — so "log in once,
// stay logged in" works even across cold containers.
//
// Providers (auto-detected, first match wins):
//   1. "vercel-blob"  — BLOB_READ_WRITE_TOKEN is set (Vercel Blob store,
//                       create one in Project → Storage; zero extra infra).
//   2. "http"         — PROFILE_HTTP_URL (must contain "{id}") pointing at
//                       any endpoint that accepts raw PUT/GET of a gzip'd
//                       tar (e.g. an S3/R2 presign proxy, your own
//                       /profiles/:id route). Optional PROFILE_HTTP_TOKEN
//                       sent as `Authorization: Bearer …`.
//
// Everything here is best-effort: failures log a warning and never break
// a browsing session.
/* eslint-disable @typescript-eslint/no-require-imports */
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const execFileP = promisify(execFile);
const { blobToken } = require("./env-blob.cjs");

// Chrome profile parts worth carrying across machines. Everything else
// (caches, crash reports, shader caches, component updates) is dropped to
// keep snapshots a few MB instead of hundreds.
// Login Data (saved passwords) is deliberately excluded unless
// PROFILE_KEEP_LOGINS=1 — sessions cookies are what "staying logged in"
// needs; saved passwords are a liability in external storage.
const KEEP_DEFAULT_ROOT = new Set(["Local State"]);
const KEEP_DEFAULT_PROFILE = new Set([
  "Cookies",
  "Cookies-journal",
  "Preferences",
  "Secure Preferences",
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "Sync Data",
  "Network",
]);
const KEEP_LOGINS = new Set(["Login Data", "Login Data-journal"]);

function safeKey(id) {
  return String(id || "main").replace(/[^a-zA-Z0-9-_]/g, "_").slice(0, 64) || "main";
}

function detectProvider() {
  if (blobToken()) return "vercel-blob";
  if (process.env.PROFILE_HTTP_URL) return "http";
  return "disabled";
}

const provider = detectProvider();

function maxBytes() {
  const mb = parseInt(process.env.PROFILE_MAX_MB || "25", 10);
  return (Number.isNaN(mb) ? 25 : mb) * 1024 * 1024;
}

// ── pack / unpack ────────────────────────────────────────────────────────────

// Clone the profile cheaply (hardlinks where possible), prune to the
// whitelist, tar+gzip the prune. Working on a clone means a *live* Chrome
// never has its files ripped out from under it.
async function packProfile(profileDir) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "browse-profile-"));
  const cloneDir = path.join(tmpRoot, "clone");
  const tarFile = path.join(tmpRoot, "profile.tar.gz");
  try {
    // Hardlink first (fast, no data dup); fall back to a real copy.
    try {
      await execFileP("cp", ["-al", profileDir, cloneDir]);
    } catch {
      await fsp.cp(profileDir, cloneDir, { recursive: true, verbatimSymlinks: true });
    }

    // Prune the clone down to the whitelist (the live dir is untouched).
    const entries = await fsp.readdir(cloneDir, { withFileTypes: true });
    const keepLogins = process.env.PROFILE_KEEP_LOGINS === "1";
    for (const e of entries) {
      const isDefaultDir = e.name === "Default" && e.isDirectory();
      if (!isDefaultDir && !KEEP_DEFAULT_ROOT.has(e.name)) {
        await fsp.rm(path.join(cloneDir, e.name), { recursive: true, force: true });
      }
    }
    const defDir = path.join(cloneDir, "Default");
    if (fs.existsSync(defDir)) {
      const keep = keepLogins
        ? new Set([...KEEP_DEFAULT_PROFILE, ...KEEP_LOGINS])
        : KEEP_DEFAULT_PROFILE;
      const defEntries = await fsp.readdir(defDir, { withFileTypes: true });
      for (const e of defEntries) {
        if (!keep.has(e.name)) {
          await fsp.rm(path.join(defDir, e.name), { recursive: true, force: true });
        }
      }
    }

    await execFileP("tar", ["-czf", tarFile, "-C", cloneDir, "."]);
    const bytes = (await fsp.stat(tarFile)).size;
    if (bytes > maxBytes()) {
      throw new Error(
        `profile snapshot ${(bytes / 1048576).toFixed(1)}MB exceeds PROFILE_MAX_MB ` +
          `(${maxBytes() / 1048576}MB) — skipping save to protect storage`
      );
    }
    return { buffer: await fsp.readFile(tarFile), cleanup: () => fsp.rm(tmpRoot, { recursive: true, force: true }) };
  } catch (err) {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function unpackProfile(tarBuffer, profileDir) {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "browse-profile-"));
  const tarFile = path.join(tmpRoot, "profile.tar.gz");
  try {
    await fsp.writeFile(tarFile, tarBuffer);
    await fsp.rm(profileDir, { recursive: true, force: true });
    await fsp.mkdir(profileDir, { recursive: true });
    await execFileP("tar", ["-xzf", tarFile, "-C", profileDir]);
    return true;
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

// ── provider backends ────────────────────────────────────────────────────────

let blobLib = null;
function getBlob() {
  if (blobLib) return blobLib;
  blobLib = require("@vercel/blob"); // lazy: only when the provider is active
  return blobLib;
}

function blobPath(key) {
  return `profiles/${key}.tar.gz`;
}

async function blobOps() {
  const blob = getBlob();
  const token = blobToken();
  return {
    async save(key, buffer) {
      await blob.put(blobPath(key), buffer, {
        access: "private",
        addRandomSuffix: false,
        contentType: "application/gzip",
        token,
      });
      return buffer.length;
    },
    async load(key) {
      const listing = await blob.list({ prefix: blobPath(key), token });
      const hit = (listing.blobs || []).find(
        (b) => b.pathname === blobPath(key)
      );
      if (!hit) return null;
      try {
        const res = await blob.download(hit.url, { token });
        return Buffer.from(await res.arrayBuffer());
      } catch {
        // Older SDK / unusual runtime: fall back to a plain fetch of the
        // (short-lived, signed) URL.
        const res = await fetch(hit.url);
        if (!res.ok) throw new Error(`blob download HTTP ${res.status}`);
        return Buffer.from(await res.arrayBuffer());
      }
    },
    async remove(key) {
      const listing = await blob.list({ prefix: blobPath(key), token });
      const urls = (listing.blobs || [])
        .filter((b) => b.pathname === blobPath(key))
        .map((b) => b.url);
      if (urls.length) await blob.del(urls, { token });
      return urls.length > 0;
    },
    async list() {
      const listing = await blob.list({ prefix: "profiles/", token });
      return (listing.blobs || [])
        .map((b) => b.pathname.replace(/^profiles\//, "").replace(/\.tar\.gz$/, ""))
        .filter(Boolean);
    },
  };
}

async function httpSave(key, buffer) {
  const url = String(process.env.PROFILE_HTTP_URL).replace(/\{id\}/g, encodeURIComponent(key));
  const headers = {
    "content-type": "application/octet-stream",
  };
  if (process.env.PROFILE_HTTP_TOKEN) {
    headers.authorization = `Bearer ${process.env.PROFILE_HTTP_TOKEN}`;
  }
  const res = await fetch(url, { method: "PUT", headers, body: buffer });
  if (!res.ok) throw new Error(`profile PUT ${res.status} ${url}`);
  return buffer.length;
}

async function httpLoad(key) {
  const url = String(process.env.PROFILE_HTTP_URL).replace(/\{id\}/g, encodeURIComponent(key));
  const headers = {};
  if (process.env.PROFILE_HTTP_TOKEN) {
    headers.authorization = `Bearer ${process.env.PROFILE_HTTP_TOKEN}`;
  }
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`profile GET ${res.status} ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function httpRemove(key) {
  const url = String(process.env.PROFILE_HTTP_URL).replace(/\{id\}/g, encodeURIComponent(key));
  const headers = {};
  if (process.env.PROFILE_HTTP_TOKEN) {
    headers.authorization = `Bearer ${process.env.PROFILE_HTTP_TOKEN}`;
  }
  const res = await fetch(url, { method: "DELETE", headers });
  return res.ok || res.status === 404;
}

// ── public API ───────────────────────────────────────────────────────────────

async function save(id, profileDir) {
  if (provider === "disabled") return { ok: false, reason: "disabled" };
  if (!fs.existsSync(profileDir)) return { ok: false, reason: "no-profile" };
  const key = safeKey(id);
  const { buffer, cleanup } = await packProfile(profileDir);
  try {
    if (provider === "vercel-blob") {
      const b = await blobOps();
      const bytes = await b.save(key, buffer);
      return { ok: true, bytes, provider };
    }
    const bytes = await httpSave(key, buffer);
    return { ok: true, bytes, provider };
  } finally {
    await cleanup();
  }
}

async function restore(id, profileDir) {
  if (provider === "disabled") return false;
  const key = safeKey(id);
  let buffer = null;
  if (provider === "vercel-blob") {
    const b = await blobOps();
    buffer = await b.load(key);
  } else {
    buffer = await httpLoad(key);
  }
  if (!buffer || buffer.length === 0) return false;
  await unpackProfile(buffer, profileDir);
  return true;
}

async function remove(id) {
  if (provider === "vercel-blob") return blobOps().remove(safeKey(id));
  if (provider === "http") return httpRemove(safeKey(id));
  return { ok: false, reason: "disabled" };
}

async function list() {
  if (provider === "vercel-blob") return blobOps().list();
  if (provider === "http") throw new Error("profile listing not supported by the http provider");
  throw new Error("profile storage disabled");
}

// Serialize saves per profile id — triggers can stack up (viewer disconnect,
// navigate, reap) and concurrent tar/upload of the same dir is wasteful.
const inflight = new Map();
function saveSerialized(id, profileDir) {
  const key = safeKey(id);
  const previous = inflight.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => save(id, profileDir));
  inflight.set(key, next);
  next.finally(() => {
    if (inflight.get(key) === next) inflight.delete(key);
  });
  return next;
}

module.exports = {
  provider,
  detectProvider,
  save: saveSerialized,
  saveRaw: save,
  restore,
  remove,
  list,
  safeKey,
};
