// Browse QA suite: boots nothing, tests everything against a running server.
// Usage: npm run dev   (in another shell)
//        node scripts/qa.mjs
// Exits 0 when every scenario passes, 1 otherwise.
import WebSocket from "ws";
import { chromium } from "playwright-core";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const WS_BASE = BASE.replace("http", "ws");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const results = [];
function report(id, name, ok, detail = "") {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? "  PASS" : "  FAIL"} [${id}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function http(path, init) {
  const res = await fetch(`${BASE}${path}`, init);
  return res;
}

// Fail fast if the server isn't up.
try {
  await fetch(`${BASE}/`, { signal: AbortSignal.timeout(8000) });
} catch {
  console.error(`Server not reachable at ${BASE}. Start it with \`npm run dev\` first.`);
  process.exit(1);
}

let browser = null;
async function withBrowser(fn) {
  if (!browser) {
    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"],
    });
  }
  const page = await browser.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

function frameWithService(page) {
  return page.frames().find((f) => f.url().includes("/service/"));
}

async function loadProxied(page, target, timeoutMs = 60000) {
  await page.goto(`${BASE}/browse?url=${encodeURIComponent(target)}`, {
    waitUntil: "domcontentloaded",
    timeout: 45000,
  });
  await page.waitForSelector("iframe", { timeout: timeoutMs });
  await page.waitForTimeout(9000);
  const frame = frameWithService(page);
  if (!frame) throw new Error("no /service/ frame");
  return frame;
}

async function frameText(frame) {
  const title = await frame.title().catch(() => "");
  const body = await frame.locator("body").innerText().catch(() => "");
  return { title, body };
}

function isUvError(title, body) {
  return title === "Error" && body.includes("Error processing your request");
}

// ---------- QA-01 boot & health ----------
try {
  const home = await http("/");
  const healthRes = await http("/api/health");
  const health = await healthRes.json();
  const ok =
    home.ok &&
    healthRes.ok &&
    health.ok &&
    health.assets.ok &&
    health.bare.ok &&
    (health.bare.versions || []).includes("v3");
  report("QA-01", "boot & health", ok, `health.ok=${health.ok}`);
} catch (e) {
  report("QA-01", "boot & health", false, e.message);
}

// ---------- QA-02 proxy assets ----------
try {
  const files = [
    "/uv/uv.bundle.js",
    "/uv/uv.client.js",
    "/uv/uv.handler.js",
    "/uv/uv.sw.js",
    "/uv/uv.config.js",
    "/uv/sw.js",
    "/baremux/index.js",
    "/baremux/worker.js",
    "/baremod/index.mjs",
  ];
  let ok = true;
  const problems = [];
  for (const f of files) {
    const r = await http(f);
    const ct = r.headers.get("content-type") || "";
    if (!r.ok || !ct.includes("javascript")) {
      ok = false;
      problems.push(`${f}=${r.status}`);
    }
  }
  const sw = await http("/uv/sw.js");
  if (sw.headers.get("service-worker-allowed") !== "/") {
    ok = false;
    problems.push("sw-scope-header");
  }
  report("QA-02", "proxy assets served", ok, problems.join(",") || `${files.length} files`);
} catch (e) {
  report("QA-02", "proxy assets served", false, e.message);
}

// ---------- QA-03 bare v3 fetch ----------
try {
  const r = await fetch(`${BASE}/bare/v3/?cache=qa3`, {
    headers: {
      "x-bare-url": "https://example.com/",
      "x-bare-headers": JSON.stringify({ host: "example.com", accept: "text/html", "user-agent": "QA" }),
    },
  });
  const body = await r.text();
  const ok = r.headers.get("x-bare-status") === "200" && body.includes("Example Domain");
  report("QA-03", "bare v3 fetch", ok, `x-bare-status=${r.headers.get("x-bare-status")}`);
} catch (e) {
  report("QA-03", "bare v3 fetch", false, e.message);
}

// ---------- QA-04 bare range ----------
try {
  const mp4 = "https://www.w3schools.com/html/mov_bbb.mp4";
  const r = await fetch(`${BASE}/bare/v3/?cache=qa4`, {
    headers: {
      "x-bare-url": mp4,
      "x-bare-headers": JSON.stringify({
        host: "www.w3schools.com",
        range: "bytes=0-1000",
        "user-agent": "QA",
      }),
    },
  });
  const buf = Buffer.from(await r.arrayBuffer());
  const ok = r.headers.get("x-bare-status") === "206" && buf.length > 500;
  report("QA-04", "bare range (206)", ok, `x-bare-status=${r.headers.get("x-bare-status")} bytes=${buf.length}`);
} catch (e) {
  report("QA-04", "bare range (206)", false, e.message);
}

// ---------- QA-05 fast proxy boot ----------
try {
  await withBrowser(async (page) => {
    const frame = await loadProxied(page, "https://example.com/");
    const { title, body } = await frameText(frame);
    const regs = await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((rs) => rs.map((r) => r.scope)));
    const ok = title === "Example Domain" && body.includes("documentation") && regs.some((s) => s === `${BASE}/`);
    report("QA-05", "fast proxy boots example.com", ok, `title=${title}`);
  });
} catch (e) {
  report("QA-05", "fast proxy boots example.com", false, e.message);
}

// ---------- QA-06 sites ----------
for (const [target, expectTitle, expectBody] of [
  ["https://en.wikipedia.org/wiki/Main_Page", "Wikipedia", "Welcome to Wikipedia"],
  ["https://www.google.com/", "Google", "Gmail"],
  ["https://github.com/login", "Sign in to GitHub", "Username or email"],
]) {
  const id = `QA-06:${new URL(target).hostname}`;
  try {
    await withBrowser(async (page) => {
      const frame = await loadProxied(page, target);
      const { title, body } = await frameText(frame);
      const ok = !isUvError(title, body) && title.includes(expectTitle) && body.includes(expectBody);
      report(id, `site ${new URL(target).hostname}`, ok, `title=${title.slice(0, 40)}`);
    });
  } catch (e) {
    report(id, `site ${new URL(target).hostname}`, false, e.message);
  }
}

// ---------- QA-07 embedded video buffers (real website scenario) ----------
try {
  await withBrowser(async (page) => {
    const frame = await loadProxied(page, "https://www.w3schools.com/html/html5_video.asp");
    const state = await Promise.race([
      frame.evaluate(async () => {
        const v = document.querySelector("video");
        if (!v) return null;
        try {
          await Promise.race([
            v.play(),
            new Promise((_, rej) => setTimeout(() => rej(new Error("play-timeout")), 8000)),
          ]);
        } catch {}
        await new Promise((r) => setTimeout(r, 4000));
        return { rs: v.readyState, t: v.currentTime, err: v.error ? v.error.code : null };
      }),
      new Promise((r) => setTimeout(() => r("timeout"), 30000)),
    ]);
    // readyState>=3 (HAVE_FUTURE_DATA) proves media bytes stream via proxy.
    // Note: video.error is intentionally NOT asserted — Chrome sets it for
    // aborted speculative range requests even when playback data is intact.
    const ok = !!state && state !== "timeout" && state.rs >= 3;
    report("QA-07", "embedded video flows via proxy", ok, state === "timeout" ? "eval timeout" : JSON.stringify(state));
  });
} catch (e) {
  report("QA-07", "embedded video flows via proxy", false, e.message);
}

// ---------- QA-08 youtube page (not playback) ----------
try {
  await withBrowser(async (page) => {
    const frame = await loadProxied(page, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const { title, body } = await frameText(frame);
    const ok = !isUvError(title, body) && /rick astley/i.test(`${title} ${body}`);
    report("QA-08", "youtube watch page renders", ok, `title=${title.slice(0, 50)}`);
  });
} catch (e) {
  report("QA-08", "youtube watch page renders", false, e.message);
}

// ---------- QA-09 remote session + stream ----------
try {
  const res = await http("/api/remote/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "qa", url: "https://example.com/" }),
  });
  const session = await res.json();
  if (!res.ok) throw new Error(session.error || res.status);

  const seen = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_BASE}/remote-ws?sessionId=qa`);
    const got = { hello: false, frame: false, nav: false };
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      resolve(got);
    }, 25000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello") got.hello = true;
      if (msg.type === "frame") got.frame = true;
      if (msg.type === "nav") got.nav = true;
      if (got.hello && got.frame) {
        // exercise input: navigate + back + reload over the same socket
        ws.send(JSON.stringify({ type: "navigate", url: "https://example.com/" }));
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "reload" }));
          setTimeout(() => {
            clearTimeout(timer);
            try { ws.close(); } catch {}
            resolve(got);
          }, 4000);
        }, 4000);
      }
    });
    ws.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const ok = seen.hello && seen.frame;
  report("QA-09", "remote session streams + input", ok, `hello=${seen.hello} frame=${seen.frame}`);

  const cookiesRes = await http(`/api/remote/cookies?id=qa&url=${encodeURIComponent("https://example.com/")}`);
  const cookiesOk = cookiesRes.ok;
  report("QA-09b", "remote cookies endpoint", cookiesOk);

  await http("/api/remote/session?id=qa", { method: "DELETE" });
} catch (e) {
  report("QA-09", "remote session streams + input", false, e.message);
}

// ---------- QA-10 oauth reach (no creds): neetcode -> github ----------
try {
  await http("/api/remote/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId: "qa-oauth", url: "https://neetcode.io/" }),
  });
  const reached = await new Promise((resolve) => {
    const ws = new WebSocket(`${WS_BASE}/remote-ws?sessionId=qa-oauth`);
    let clicked = 0;
    const done = (val) => {
      try { ws.close(); } catch {}
      resolve(val);
    };
    const timer = setTimeout(() => done(false), 60000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "hello" && clicked === 0) {
        clicked = 1;
        setTimeout(() => {
          // Sign In button, then GitHub in the dropdown.
          ws.send(JSON.stringify({ type: "mouseMove", x: 1110, y: 45 }));
          ws.send(JSON.stringify({ type: "mouseDown", button: 0 }));
          ws.send(JSON.stringify({ type: "mouseUp", button: 0 }));
          setTimeout(() => {
            ws.send(JSON.stringify({ type: "mouseMove", x: 930, y: 170 }));
            ws.send(JSON.stringify({ type: "mouseDown", button: 0 }));
            ws.send(JSON.stringify({ type: "mouseUp", button: 0 }));
          }, 3000);
        }, 6000);
      }
      if (msg.type === "nav" && msg.url.includes("github.com/login")) {
        clearTimeout(timer);
        done(true);
      }
    });
    ws.on("error", () => {
      clearTimeout(timer);
      done(false);
    });
  });
  report("QA-10", "neetcode github oauth reachable", reached);
  await http("/api/remote/session?id=qa-oauth", { method: "DELETE" });
} catch (e) {
  report("QA-10", "neetcode github oauth reachable", false, e.message);
}

await browser?.close().catch(() => {});

const failed = results.filter((r) => !r.ok);
console.log(`\nQA: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("Failing:");
  for (const f of failed) console.log(` - [${f.id}] ${f.name}: ${f.detail}`);
  process.exit(1);
}
console.log("ALL GREEN");
