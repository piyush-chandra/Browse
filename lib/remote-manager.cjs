// Manages persistent real-Chromium sessions streamed to the browser via CDP
// screencast. This is the escape hatch for sites that defeat fetch-proxies:
// OAuth logins (Google/GitHub), bot checks, captchas, DRM.
//
// Intentionally CommonJS: required directly by server.js outside the Next compiler.
/* eslint-disable @typescript-eslint/no-require-imports */
//
// Sessions keep a real Chrome profile on disk (./data/remote/<id>) so logins
// survive restarts. Idle sessions with no viewers are reaped; the profile
// stays and the browser is relaunched on demand.
const { chromium } = require("playwright-core");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const profileStore = require("./profile-store.cjs");

const VIEWPORT = { width: 1280, height: 800 };
const DATA_ROOT = path.join(__dirname, "..", "data", "remote");
const MAX_SESSIONS = 3;
const IDLE_MS = 15 * 60 * 1000;
const START_URL = "https://neetcode.io/";

function resolveChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.platform === "darwin") {
    const mac = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (fs.existsSync(mac)) return mac;
  }
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      const found = execSync(`which ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (found) return found;
    } catch {
      // try next
    }
  }
  throw new Error("No Chrome/Chromium found. Set CHROME_PATH to its binary.");
}

// Runs in every page before any site script. Hides the most common
// automation tells. Not perfect, but enough for GitHub/NeetCode-style flows.
const STEALTH_INIT = `(() => {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    if (!window.chrome) {
      Object.defineProperty(window, "chrome", {
        get: () => ({ runtime: {}, loadTimes: function () {}, csi: function () {} }),
      });
    }
    const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = (params) =>
      params && params.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(params);
    // Make common function toString checks look native.
    const nativeToString = Function.prototype.toString;
    const patch = (obj, prop) => {
      try {
        const fn = obj[prop];
        if (typeof fn === "function" && !nativeToString.call(fn).includes("[native code]")) {
          Object.defineProperty(fn, "toString", { value: nativeToString.bind(fn) });
        }
      } catch {}
    };
    patch(window.navigator.permissions, "query");
  } catch {}
})();`;

function clamp(n, min, max) {
  n = Math.round(Number(n));
  if (Number.isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function mouseButton(n) {
  return n === 1 ? "middle" : n === 2 ? "right" : "left";
}

const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);

function normalizeUrl(raw) {
  let target = String(raw || "").trim();
  if (!target) throw new Error("Empty URL");
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) target = "https://" + target;
  return target;
}

class RemoteManager {
  constructor() {
    this.sessions = new Map();
    this.resolvingChrome = null;
    setInterval(() => this.reapIdle(), 60_000).unref();
  }

  async getOrCreate(id, url) {
    id = String(id || "main").slice(0, 64) || "main";
    let session = this.sessions.get(id);
    if (session && !session.dead) {
      if (url) await this.navigateTo(session, url);
      session.lastActive = Date.now();
      return session;
    }
    this.sessions.delete(id);
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error("Too many remote browser sessions open");
    }
    session = await this.create(id, url);
    this.sessions.set(id, session);
    return session;
  }

  get(id) {
    return this.sessions.get(String(id || "main")) || null;
  }

  async create(id, url) {
    const userDataDir = path.join(DATA_ROOT, id.replace(/[^a-zA-Z0-9-_]/g, "_"));
    fs.mkdirSync(userDataDir, { recursive: true });

    // Ephemeral-disk hosts (Vercel): the profile dir just vanished from the
    // disk, so restore the last snapshot from external storage first. On a
    // persistent host this returns false and is a no-op.
    let restored = false;
    try {
      restored = await profileStore.restore(id, userDataDir);
      if (restored) console.log(`[remote] profile ${id}: restored from ${profileStore.provider}`);
    } catch (err) {
      console.warn(`[remote] profile ${id}: restore failed: ${err.message}`);
    }

    // headed unless REMOTE_HEADLESS=false is unset... default to headless=new:
    // Playwright's own --headless is the old, easily-detected mode, so we
    // pass headless:false and add --headless=new ourselves.
    const headless = process.env.REMOTE_HEADLESS !== "false";
    const launchArgs = [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-features=TranslateUI",
      // Required when running as root (Docker / most PaaS). Harmless
      // elsewhere; this is a server-side browser, not a user desktop.
      "--no-sandbox",
      "--disable-setuid-sandbox",
      ...(headless ? ["--headless=new", "--disable-gpu"] : []),
    ];
    const launch = () =>
      chromium.launchPersistentContext(userDataDir, {
        executablePath: resolveChrome(),
        headless: false,
        args: launchArgs,
        // --enable-automation is Playwright's biggest tell (infobar + flag).
        ignoreDefaultArgs: ["--enable-automation"],
        viewport: VIEWPORT,
        deviceScaleFactor: 1,
        locale: "en-US",
      });
    let context;
    try {
      context = await launch();
    } catch {
      // A previous browser may not have released the profile lock yet.
      // If it's genuinely gone, the lock files are stale; clear and retry once.
      for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
        try {
          fs.unlinkSync(path.join(userDataDir, lock));
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 1000));
      context = await launch();
    }
    await context.addInitScript(STEALTH_INIT);

    const session = {
      id,
      context,
      page: null,
      cdp: null,
      clients: new Set(),
      lastActive: Date.now(),
      dead: false,
      screencast: false,
      lastFrame: null,
      url: "about:blank",
      title: "",
      lastNavMsg: "",
    };
    session.userDataDir = userDataDir;

    context.on("page", (page) => {
      // OAuth and target=_blank links open new tabs; follow them.
      if (!session.dead) this.attachPage(session, page).catch(() => {});
    });
    const first = context.pages()[0] || (await context.newPage());
    await this.attachPage(session, first);
    await this.navigateTo(session, url || START_URL);
    return session;
  }

  async attachPage(session, page) {
    if (session.cdp) {
      try {
        await session.cdp.send("Page.stopScreencast");
      } catch {}
      try {
        await session.cdp.detach();
      } catch {}
    }
    session.page = page;
    session.screencast = false;
    const cdp = await session.context.newCDPSession(page);
    session.cdp = cdp;

    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) this.pushNav(session);
    });
    page.on("load", () => this.pushNav(session));
    page.on("close", () => {
      // If our visible tab closed but others exist, follow one of them.
      const others = session.context.pages().filter((p) => p !== page);
      if (others.length && !session.dead) {
        this.attachPage(session, others[0]).catch(() => {});
      }
    });

    cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      session.lastFrame = data;
      session.lastActive = Date.now();
      this.broadcast(session, JSON.stringify({ type: "frame", data }));
      cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
    });

    if (session.clients.size > 0) {
      await this.ensureScreencast(session);
    }
    this.pushNav(session);
  }

  async navigateTo(session, rawUrl) {
    const target = normalizeUrl(rawUrl);
    session.lastActive = Date.now();
    await session.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
    await this.pushNav(session);
    // Navigation is the natural checkpoint: after a login flow lands, the
    // cookies are on disk. (Best-effort; failures never break browsing.)
    profileStore
      .save(session.id, session.userDataDir)
      .then((r) => {
        if (r.ok) console.log(`[remote] profile ${session.id}: saved (${(r.bytes / 1024).toFixed(0)}KB)`);
      })
      .catch((err) => console.warn(`[remote] profile ${session.id}: save failed: ${err.message}`));
  }

  async pushNav(session) {
    try {
      const url = session.page.url();
      const title = await session.page.title().catch(() => "");
      session.url = url;
      session.title = title;
      const msg = JSON.stringify({ type: "nav", url, title });
      if (msg !== session.lastNavMsg) {
        session.lastNavMsg = msg;
        this.broadcast(session, msg);
      }
    } catch {
      // page gone; attach handler will recover
    }
  }

  broadcast(session, msg) {
    for (const ws of session.clients) {
      try {
        if (ws.readyState === 1 && ws.bufferedAmount < 1024 * 1024) {
          ws.send(msg);
        }
      } catch {
        // drop broken client on next close event
      }
    }
  }

  async ensureScreencast(session) {
    if (session.screencast || !session.cdp) return;
    await session.cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: VIEWPORT.width,
      maxHeight: VIEWPORT.height,
      everyNthFrame: 2,
    });
    session.screencast = true;
  }

  async stopScreencast(session) {
    if (!session.screencast || !session.cdp) return;
    try {
      await session.cdp.send("Page.stopScreencast");
    } catch {}
    session.screencast = false;
  }

  async handleConnection(ws, sessionId, initialUrl) {
    let session;
    try {
      // The WS is the rendezvous: it's long-lived (pinned to whichever
      // Fluid instance accepted the upgrade) and creates the session on
      // demand — with the profile restored from external storage if this
      // is a cold instance. That makes cross-instance session 404s (the
      // classic Vercel breakage) structurally impossible for viewers.
      session = await this.getOrCreate(sessionId, initialUrl);
    } catch (err) {
      try {
        ws.send(JSON.stringify({ type: "error", message: err.message }));
        ws.close();
      } catch {}
      return;
    }

    session.clients.add(ws);
    session.lastActive = Date.now();
    try {
      await this.ensureScreencast(session);
    } catch (err) {
      ws.send(JSON.stringify({ type: "error", message: `screencast: ${err.message}` }));
    }
    ws.send(
      JSON.stringify({ type: "hello", viewport: VIEWPORT, url: session.url, title: session.title })
    );
    if (session.lastFrame) {
      ws.send(JSON.stringify({ type: "frame", data: session.lastFrame }));
    }

    ws.on("message", (raw) => {
      this.handleMessage(session, raw).catch((err) => {
        try {
          ws.send(JSON.stringify({ type: "error", message: err.message }));
        } catch {}
      });
    });
    const drop = () => {
      session.clients.delete(ws);
      session.lastActive = Date.now();
      if (session.clients.size === 0) this.stopScreencast(session).catch(() => {});
    };
    ws.on("close", drop);
    ws.on("error", () => {
      try {
        ws.close();
      } catch {}
      drop();
    });
  }

  async handleMessage(session, raw) {
    if (session.dead) throw new Error("session closed");
    const msg = JSON.parse(raw.toString());
    session.lastActive = Date.now();
    const page = session.page;
    if (!page || page.isClosed()) throw new Error("page closed");

    switch (msg.type) {
      case "mouseMove":
        await page.mouse.move(
          clamp(msg.x, 0, VIEWPORT.width),
          clamp(msg.y, 0, VIEWPORT.height)
        );
        break;
      case "mouseDown":
        await page.mouse.down({ button: mouseButton(msg.button) });
        break;
      case "mouseUp":
        await page.mouse.up({ button: mouseButton(msg.button) });
        break;
      case "wheel":
        await page.mouse.wheel(clamp(msg.deltaX || 0, -500, 500), clamp(msg.deltaY || 0, -500, 500));
        break;
      case "keyDown": {
        const key = String(msg.key || "");
        if (!key || key === "Unidentified" || key === "Dead") break;
        if (MODIFIERS.has(key)) await page.keyboard.down(key);
        else await page.keyboard.press(key).catch(() => page.keyboard.type(key).catch(() => {}));
        if (msg.repeat) break;
        break;
      }
      case "keyUp": {
        const key = String(msg.key || "");
        if (MODIFIERS.has(key)) await page.keyboard.up(key);
        break;
      }
      case "navigate":
        await this.navigateTo(session, msg.url);
        break;
      case "back":
        await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
        break;
      case "forward":
        await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
        break;
      case "reload":
        await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
        break;
      default:
        break;
    }
  }

  async getCookies(id, url) {
    const session = this.sessions.get(String(id || "main"));
    if (!session || session.dead) throw new Error("no such session");
    const cookies = url
      ? await session.context.cookies(normalizeUrl(url))
      : await session.context.cookies();
    return cookies;
  }

  async close(id) {
    const session = this.sessions.get(String(id || "main"));
    if (!session) {
      // Session may be gone server-side but still have a profile snapshot
      // worth removing on demand.
      return false;
    }
    this.sessions.delete(session.id);
    session.dead = true;
    for (const ws of session.clients) {
      try {
        ws.send(JSON.stringify({ type: "error", message: "session closed" }));
        ws.close();
      } catch {}
    }
    session.clients.clear();
    try {
      // Flush the profile before the browser releases the dir.
      await profileStore.save(session.id, session.userDataDir).catch(() => {});
    } catch {}
    try {
      await session.context.close();
    } catch {}
    return true;
  }

  reapIdle() {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (session.clients.size === 0 && now - session.lastActive > IDLE_MS) {
        console.log(`[remote] reaping idle session ${session.id}`);
        this.close(session.id).catch(() => {});
      }
    }
  }

  saveProfile(id) {
    const session = this.sessions.get(String(id || "main"));
    if (!session || session.dead) throw new Error("no such session");
    return profileStore.save(session.id, session.userDataDir);
  }

  // Inject cookies (e.g. exported from the user's own desktop browser) into
  // a session's Chrome context and persist them. This is the "import my
  // login" path: it makes the session logged-in without anyone typing
  // credentials into the remote browser.
  async importCookies(id, cookies) {
    if (!Array.isArray(cookies) || cookies.length === 0) {
      throw new Error("cookies array required");
    }
    if (cookies.length > 500) throw new Error("too many cookies (max 500)");
    const cleaned = cookies.map((c) => {
      const out = {
        name: String(c.name || "").slice(0, 256),
        value: String(c.value || "").slice(0, 8192),
        domain: String(c.domain || "").slice(0, 256),
        path: String(c.path || "/").slice(0, 256),
        secure: c.secure !== false,
        httpOnly: c.httpOnly === true,
      };
      if (!out.name || !out.domain) throw new Error("cookie missing name/domain");
      if (c.expires && Number.isFinite(Number(c.expires)) && Number(c.expires) > 0) {
        out.expires = Math.floor(Number(c.expires));
      }
      if (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None") {
        out.sameSite = c.sameSite;
      }
      return out;
    });
    const session = await this.getOrCreate(id);
    await session.context.addCookies(cleaned);
    await profileStore.save(session.id, session.userDataDir).catch((err) =>
      console.warn(`[remote] profile ${session.id}: post-import save failed: ${err.message}`)
    );
    return { imported: cleaned.length, sessionId: session.id };
  }

  describe(id) {
    const session = this.sessions.get(String(id || "main"));
    if (!session || session.dead) return null;
    return {
      sessionId: session.id,
      url: session.url,
      title: session.title,
      viewers: session.clients.size,
      viewport: VIEWPORT,
    };
  }

  // Live sessions with their profile dirs (used by the SIGTERM flush).
  listSessions() {
    return [...this.sessions.values()]
      .filter((s) => s && !s.dead && s.userDataDir)
      .map((s) => ({ id: s.id, userDataDir: s.userDataDir }));
  }
}

module.exports = { RemoteManager, VIEWPORT };
