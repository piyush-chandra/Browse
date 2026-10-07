// Shared Ultraviolet + bare-mux boot logic (client-only: touches
// window/document/navigator, so import only from "use client" components).
//
// Used by /browse (boots the proxy, then points an iframe at /service/…)
// and by /service/[...path] (cold-loaded proxied link: boots the proxy,
// then reloads so the service worker can intercept this URL).

export const PREFIX = "/service/";
export const SW_URL = "/uv/sw.js";
export const BAREMUX_WORKER = "/baremux/worker.js";
export const TRANSPORT = "/baremod/index.mjs";

// Per-deploy asset version (inlined at build time by next.config.ts).
// Defeats poisoned caches: a corporate gateway (or browser) holding a 404
// from the pre-UV era keys on the bare URL — a fresh ?v= is a new key.
const ASSET_V = process.env.NEXT_PUBLIC_ASSET_V;
const v = (src: string) => (ASSET_V ? `${src}?v=${ASSET_V}` : src);

declare global {
  interface Window {
    BareMux?: {
      BareMuxConnection: new (worker: string) => {
        setTransport: (path: string, options: unknown[]) => Promise<void>;
      };
    };
    Ultraviolet?: {
      codec: {
        xor: {
          encode: (url: string) => string;
          decode: (encoded: string) => string;
        };
      };
    };
  }
}

/**
 * Boots the proxy exactly once per page load:
 *  1. load bare-mux + the Ultraviolet bundle
 *  2. register the Ultraviolet service worker at root scope
 *  3. tell bare-mux which transport to use (our /bare/ server)
 *
 * The service worker pulls its transport port from this page, so this must
 * finish before the first /service/ request is made.
 */
let proxyReady: Promise<void> | null = null;

const SCRIPT_TIMEOUT_MS = 15000;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Drop tags from a previous failed attempt: their load/error events
    // already fired, so reusing them would hang forever.
    const stale = document.querySelector<HTMLScriptElement>(
      `script[data-browse-src="${src}"]:not([data-loaded="true"])`
    );
    if (stale) stale.remove();

    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-browse-src="${src}"][data-loaded="true"]`
    );
    if (existing) return resolve();

    const timer = setTimeout(() => {
      el.remove();
      reject(
        new Error(
          `Timed out loading ${src}. The proxy files may be missing — restart the app with \`npm run dev\`.`
        )
      );
    }, SCRIPT_TIMEOUT_MS);

    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.dataset.browseSrc = src;
    el.addEventListener("load", () => {
      clearTimeout(timer);
      el.dataset.loaded = "true";
      resolve();
    });
    el.addEventListener("error", () => {
      clearTimeout(timer);
      el.remove();
      reject(
        new Error(
          `Failed to load ${src} (HTTP error). Hard-refresh once (Ctrl/Cmd+Shift+R) to evict stale caches; if it persists, the network may be filtering the proxy runtime.`
        )
      );
    });
    document.head.appendChild(el);
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Purge the legacy hand-rolled `/browse-sw.js` service worker, if present.
 *
 * Why this must run BEFORE loading any proxy asset: that SW (pre-UV builds,
 * scope "/") intercepts every subresource of /browse and rewrites it to
 * /api/browse?url=… — a route that no longer exists → the very first boot
 * script (/baremux/index.js) 404s, and the cleanup further down would never
 * run. Catch-22.
 *
 * unregister() alone doesn't uncontrol the CURRENT page (fetches keep
 * routing to the doomed SW until unload), so after a purge we reload once.
 * Returns true when a reload was triggered (callers: stop, page is going).
 */
const SW_PURGE_FLAG = "browse.legacy-sw-purged";
async function purgeLegacyServiceWorker(): Promise<boolean> {
  if (!("serviceWorker" in navigator)) return false;
  let registrations: readonly ServiceWorkerRegistration[] = [];
  try {
    registrations = await navigator.serviceWorker.getRegistrations();
  } catch {
    return false;
  }
  const legacy = registrations.filter((registration) =>
    [registration.installing, registration.waiting, registration.active].some(
      (worker) => worker?.scriptURL.includes("/browse-sw.js")
    )
  );
  if (legacy.length === 0) return false;
  await Promise.all(legacy.map((registration) => registration.unregister()));
  // Drop anything the old SW cached, so it can't resurface later.
  try {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
  } catch {}
  // Reload exactly once (flag guards against loops if unregister failed).
  try {
    if (!sessionStorage.getItem(SW_PURGE_FLAG)) {
      sessionStorage.setItem(SW_PURGE_FLAG, "1");
      window.location.reload();
      return true;
    }
    // Already reloaded once and it's STILL there — stop looping, let boot
    // proceed and surface a normal error if the SW keeps interfering.
    sessionStorage.removeItem(SW_PURGE_FLAG);
  } catch {
    window.location.reload();
    return true;
  }
  return false;
}

export function initProxy(): Promise<void> {
  if (proxyReady) return proxyReady;

  proxyReady = (async () => {
    // FIRST: purge the legacy SW before it can 404 our boot scripts.
    if (await purgeLegacyServiceWorker()) {
      // Page is reloading; never resolve.
      await new Promise<void>(() => {});
    }

    await loadScript(v("/baremux/index.js"));
    await loadScript(v("/uv/uv.bundle.js"));

    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers are not supported in this browser.");
    }

    await navigator.serviceWorker.register(v(SW_URL), { scope: "/" });
    await withTimeout(
      navigator.serviceWorker.ready,
      15000,
      "Service worker activation"
    );

    // `ready` only means a worker is active — the page itself must also be
    // *controlled* by it, otherwise /service/ navigations bypass the proxy
    // and Next.js serves app HTML (e.g. videos fail with network errors).
    // This is a race with clients.claim(); wait it out, don't hang on it.
    if (!navigator.serviceWorker.controller) {
      await withTimeout(
        new Promise<void>((resolve) => {
          const onChange = () => {
            navigator.serviceWorker.removeEventListener("controllerchange", onChange);
            resolve();
          };
          navigator.serviceWorker.addEventListener("controllerchange", onChange);
          if (navigator.serviceWorker.controller) {
            navigator.serviceWorker.removeEventListener("controllerchange", onChange);
            resolve();
          }
        }),
        10000,
        "Service worker taking control"
      ).catch(() => {
        throw new Error(
          "Service worker is active but not controlling this page. Reload the page to retry. " +
            "(If this persists, unregister service workers in DevTools > Application.)"
        );
      });
    }

    if (!window.BareMux) {
      throw new Error("bare-mux failed to load.");
    }

    const connection = new window.BareMux.BareMuxConnection(v(BAREMUX_WORKER));
    await withTimeout(
      connection.setTransport(v(TRANSPORT), [`${window.location.origin}/bare/`]),
      15000,
      "Proxy transport setup"
    );
  })().catch((error) => {
    proxyReady = null;
    throw error;
  });

  return proxyReady;
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/** Decode a /service/<encoded> pathname back to the target URL, or null. */
export function decodeServicePath(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  try {
    const codec = window.Ultraviolet?.codec.xor;
    if (!codec) return null;
    return codec.decode(pathname.slice(PREFIX.length));
  } catch {
    return null;
  }
}
