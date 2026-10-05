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
          `Failed to load ${src} (HTTP error). The proxy files may be missing — restart the app with \`npm run dev\`.`
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

export function initProxy(): Promise<void> {
  if (proxyReady) return proxyReady;

  proxyReady = (async () => {
    await loadScript("/baremux/index.js");
    await loadScript("/uv/uv.bundle.js");

    if (!("serviceWorker" in navigator)) {
      throw new Error("Service workers are not supported in this browser.");
    }

    // Clean up the legacy hand-rolled proxy service worker, if present.
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(
      registrations
        .filter((registration) =>
          [registration.installing, registration.waiting, registration.active].some(
            (worker) => worker?.scriptURL.includes("/browse-sw.js")
          )
        )
        .map((registration) => registration.unregister())
    );

    await navigator.serviceWorker.register(SW_URL, { scope: "/" });
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

    const connection = new window.BareMux.BareMuxConnection(BAREMUX_WORKER);
    await withTimeout(
      connection.setTransport(TRANSPORT, [`${window.location.origin}/bare/`]),
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
