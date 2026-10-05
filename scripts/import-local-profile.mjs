#!/usr/bin/env node
// Import your desktop Chrome login into a Browse remote session.
//
// Why this exists: on macOS, Chrome encrypts cookies with a key held in
// your Keychain ("Chrome Safe Storage"), so copying the profile files to
// the server yields undecryptable blobs. Instead, this script launches
// YOUR real Chrome binary (headless) on a COPY of your profile — Chrome
// itself decrypts its own cookies — reads them via CDP/Playwright, and
// POSTs them to the server, which injects them into the remote session
// and persists the profile to external storage (Vercel Blob etc.).
//
// After this, /remote?session=google opens already logged-in, so Google
// sign-in (and "Continue with Google" on sites like NeetCode) is one
// click — no typing credentials into the remote browser.
//
// Usage (from the repo root, where playwright-core is installed):
//   node scripts/import-local-profile.mjs \
//     --url https://browse-delta.vercel.app \
//     --session google \
//     --domains accounts.google.com,google.com,neetcode.io \
//     [--token <IMPORT_TOKEN>]      # required if the server sets IMPORT_TOKEN
//     [--profile "Profile Name"]    # Chrome profile to read (default: Default)
//     [--keep]                      # keep the temp profile copy
//
// Close Chrome first for a clean snapshot (the cookie DB is copied live
// otherwise; usually fine, but a clean copy is exact).
//
// Limits: macOS Chrome is the well-supported path (this script's origin).
// Windows Chrome ≥127 uses App-Bound Encryption and will NOT decrypt this
// way; Linux depends on your keyring setup.
/* eslint-disable @typescript-eslint/no-require-imports */
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--keep") out.keep = true;
    else if (a.startsWith("--")) out[a.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv);
const TARGET = args.url;
const SESSION = args.session || "google";
const DOMAINS = String(args.domains || "accounts.google.com,google.com")
  .split(",")
  .map((d) => d.trim().replace(/^\.+/, ""))
  .filter(Boolean);
const TOKEN = args.token || process.env.IMPORT_TOKEN || null;

if (!TARGET) {
  console.error("usage: node scripts/import-local-profile.mjs --url https://<your-deploy> [--session google] [--domains a.com,b.com] [--token T]");
  process.exit(1);
}

function findChrome() {
  const candidates =
    process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : process.platform === "win32"
        ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]
        : ["google-chrome", "google-chrome-stable"];
  for (const c of candidates) {
    try {
      return execFileSync("which", [c]).toString().trim() || c;
    } catch {
      if (fs.existsSync(c)) return c;
    }
  }
  throw new Error("Chrome not found");
}

function userDataDir() {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library/Application Support/Google/Chrome");
    case "win32":
      return path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/User Data");
    default:
      return path.join(os.homedir(), ".config/google-chrome");
  }
}

async function main() {
  const chrome = findChrome();
  const src = userDataDir();
  const profileName = args.profile || "Default";
  const srcProfile = path.join(src, profileName);
  if (!fs.existsSync(srcProfile)) {
    throw new Error(`profile not found: ${srcProfile} (pass --profile "Profile 1")`);
  }
  console.log(`[import] Chrome: ${chrome}`);
  console.log(`[import] source profile: ${srcProfile}`);

  // Minimal copy — only what cookie decryption + a headless start need.
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "browse-import-"));
  const dstProfile = path.join(tmp, profileName);
  await fsp.mkdir(dstProfile, { recursive: true });
  await fsp.copyFile(path.join(src, "Local State"), path.join(tmp, "Local State"));
  const COPY = ["Cookies", "Cookies-journal", "Preferences", "Secure Preferences", "Network"];
  for (const f of COPY) {
    const from = path.join(srcProfile, f);
    if (fs.existsSync(from)) {
      await fsp.cp(from, path.join(dstProfile, f), { recursive: true, verbatimSymlinks: true });
    }
  }
  for (const dir of ["Local Storage", "Session Storage", "IndexedDB"]) {
    const from = path.join(srcProfile, dir);
    if (fs.existsSync(from)) {
      await fsp.cp(from, path.join(dstProfile, dir), { recursive: true, verbatimSymlinks: true });
    }
  }
  console.log("[import] profile copied (minimal subset)");

  const urls = [];
  for (const d of DOMAINS) {
    urls.push(`https://${d}/`, `https://www.${d}/`, `https://${d.replace(/^www\./, "")}/`);
  }

  let cookies;
  try {
    const context = await chromium.launchPersistentContext(tmp, {
      executablePath: chrome,
      headless: true,
      args: ["--no-first-run", "--no-default-browser-check", "--headless=new", "--disable-gpu"],
    });
    // The engine needs the keychain item; give it a beat to settle.
    await context.addCookies([]);
    cookies = await context.cookies(urls);
    await context.close();
  } finally {
    if (args.keep) {
      console.log(`[import] kept temp profile at ${tmp}`);
    } else {
      await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  }

  if (!cookies.length) {
    console.error("[import] no cookies found for domains:", DOMAINS.join(", "));
    console.error("        Are you actually logged in to those sites in this Chrome profile?");
    process.exit(2);
  }
  console.log(`[import] extracted ${cookies.length} cookies for: ${DOMAINS.join(", ")}`);

  const headers = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  const endpoint = new URL("/api/remote/profile/cookies", TARGET);
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ sessionId: SESSION, cookies }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`[import] server rejected: HTTP ${res.status}`, JSON.stringify(data));
    if (res.status === 401) {
      console.error("        Set IMPORT_TOKEN on the server and pass --token.");
    }
    process.exit(3);
  }
  console.log(
    `[import] ✔ injected ${data.imported} cookies into session "${data.sessionId}" ` +
      `and saved the profile (${TARGET})`
  );
  console.log(`[import] done. Open ${TARGET}/remote?session=${encodeURIComponent(SESSION)} — you're logged in.`);
}

main().catch((err) => {
  console.error("[import] FAILED:", err.message);
  process.exit(1);
});
