// End-to-end verification of the Ultraviolet proxy.
// Usage: node scripts/verify-proxy.mjs [targetUrl]
import { chromium } from "playwright-core";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = process.env.BASE_URL || "http://localhost:3000";
const target = process.argv[2] || "https://example.com/";

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();

const errors = [];
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));

console.log(`→ ${BASE}/browse?url=${target}`);
await page.goto(`${BASE}/browse?url=${encodeURIComponent(target)}`, {
  waitUntil: "domcontentloaded",
  timeout: 60000,
});

// Wait for the proxy service worker to boot and the iframe to appear.
await page.waitForSelector("iframe", { timeout: 60000 });
await page.waitForTimeout(9000);

const frame = page.frames().find((f) => f.url().includes("/service/"));
let ok = false;

if (!frame) {
  console.log("✗ no /service/ frame. Frames:");
  for (const f of page.frames()) console.log("   -", f.url());
} else {
  const title = await frame.title().catch(() => "(unavailable)");
  const text = await frame
    .locator("body")
    .innerText()
    .catch(() => "");
  console.log("✓ proxied frame:", frame.url().slice(0, 110));
  console.log("  title :", title);
  console.log("  body  :", text.replace(/\s+/g, " ").trim().slice(0, 160));
  ok = text.trim().length > 0;
}

if (errors.length) {
  console.log("\nerrors:");
  console.log(errors.slice(-10).join("\n"));
}

await page.screenshot({ path: "/tmp/browse-verify.png" });
console.log("\nscreenshot: /tmp/browse-verify.png");
console.log(ok ? "\nRESULT: PASS" : "\nRESULT: FAIL");

await browser.close();
process.exit(ok ? 0 : 1);
