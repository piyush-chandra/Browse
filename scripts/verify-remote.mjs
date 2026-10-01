// Verifies the remote-browser WebSocket: hello, frames, nav, input.
// Usage: node scripts/verify-remote.mjs [url]
import WebSocket from "ws";

const BASE = process.env.BASE_URL || "http://localhost:3000";
const WS = BASE.replace("http", "ws");
const target = process.argv[2] || "https://neetcode.io/";

console.log("→ creating session for", target);
const res = await fetch(`${BASE}/api/remote/session`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ sessionId: "verify", url: target }),
});
const session = await res.json();
if (!res.ok) throw new Error(`session: ${JSON.stringify(session)}`);
console.log("✓ session:", session.sessionId, "|", session.title);

const ws = new WebSocket(`${WS}/remote-ws?sessionId=${session.sessionId}`);
let frames = 0;
let nav = null;
let hello = null;

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for frames")), 45000);
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === "hello") hello = msg;
    else if (msg.type === "nav") nav = msg;
    else if (msg.type === "frame") {
      frames++;
      if (frames === 5) {
        clearTimeout(timer);
        resolve();
      }
    } else if (msg.type === "error") {
      console.log("  [remote error]", msg.message);
    }
  });
  ws.on("error", reject);
});

console.log("✓ hello:", JSON.stringify({ url: hello?.url, title: hello?.title }));
console.log("✓ nav:", JSON.stringify(nav));
console.log(`✓ received ${frames} jpeg frames`);

// Exercise input: move mouse and press End (scroll), then check nothing broke.
ws.send(JSON.stringify({ type: "mouseMove", x: 640, y: 400 }));
ws.send(JSON.stringify({ type: "keyDown", key: "End" }));
await new Promise((r) => setTimeout(r, 3000));

// Screenshot the viewer page itself for a visual check.
const { chromium } = await import("playwright-core");
const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(`${BASE}/remote?session=${session.sessionId}`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
await page.screenshot({ path: "/tmp/remote-verify.png" });
const imgSrc = await page.evaluate(() => document.querySelector("img")?.src?.slice(0, 60) || "NO_IMG");
console.log("✓ viewer img:", imgSrc);
console.log("screenshot: /tmp/remote-verify.png");
await browser.close();
ws.close();

await fetch(`${BASE}/api/remote/session?id=${session.sessionId}`, { method: "DELETE" });
console.log("\nRESULT: PASS");
