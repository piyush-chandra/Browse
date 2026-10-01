"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

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

const PREFIX = "/service/";
const SW_URL = "/uv/sw.js";
const BAREMUX_WORKER = "/baremux/worker.js";
const TRANSPORT = "/baremod/index.mjs";

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

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-browse-src="${src}"]`
    );
    if (existing) {
      if (existing.dataset.loaded === "true") return resolve();
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () =>
        reject(new Error(`Failed to load ${src}`))
      );
      return;
    }
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.dataset.browseSrc = src;
    el.addEventListener("load", () => {
      el.dataset.loaded = "true";
      resolve();
    });
    el.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)));
    document.head.appendChild(el);
  });
}

function initProxy(): Promise<void> {
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
    await navigator.serviceWorker.ready;

    if (!window.BareMux) {
      throw new Error("bare-mux failed to load.");
    }

    const connection = new window.BareMux.BareMuxConnection(BAREMUX_WORKER);
    await connection.setTransport(TRANSPORT, [
      `${window.location.origin}/bare/`,
    ]);
  })().catch((error) => {
    proxyReady = null;
    throw error;
  });

  return proxyReady;
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

function BrowseContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialUrl = normalizeUrl(searchParams.get("url") ?? "");

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [address, setAddress] = useState(initialUrl);
  const [input, setInput] = useState(initialUrl);
  const [frame, setFrame] = useState<{ src: string; key: number } | null>(null);

  // Boot the proxy, then point the iframe at the encoded target.
  useEffect(() => {
    if (!initialUrl) return;
    let cancelled = false;

    initProxy()
      .then(() => {
        if (cancelled || !window.Ultraviolet) return;
        const src = PREFIX + window.Ultraviolet.codec.xor.encode(initialUrl);
        setFrame({ src, key: 1 });
        setStatus("ready");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [initialUrl]);

  const navigate = useCallback(
    (raw: string) => {
      const target = normalizeUrl(raw);
      if (!target || !window.Ultraviolet) return;
      setAddress(target);
      setInput(target);
      const src = PREFIX + window.Ultraviolet.codec.xor.encode(target);
      setFrame((current) => ({ src, key: (current?.key ?? 0) + 1 }));
    },
    []
  );

  // The iframe is same-origin, so we can read the real /service/ URL and decode
  // it to keep the address bar in sync as the user clicks around.
  const handleFrameLoad = useCallback(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win || !window.Ultraviolet) return;
    try {
      const path = win.location.pathname;
      if (path.startsWith(PREFIX)) {
        const decoded = window.Ultraviolet.codec.xor.decode(path.slice(PREFIX.length));
        setAddress(decoded);
        setInput(decoded);
      }
    } catch {
      // Ignore cross-origin reads (shouldn't happen for /service/).
    }
  }, []);

  const openInNewTab = useCallback(() => {
    if (!window.Ultraviolet || !address) return;
    window.open(PREFIX + window.Ultraviolet.codec.xor.encode(address), "_blank");
  }, [address]);

  // Hand the current page to a real Chromium for logins/bot checks.
  const openInRealBrowser = useCallback(async () => {
    if (!address) return;
    try {
      const res = await fetch("/api/remote/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: address }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      router.push(`/remote?session=${encodeURIComponent(data.sessionId)}`);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  }, [address, router]);

  if (!initialUrl) {
    return (
      <div className="flex bg-neutral-950 items-center justify-center min-h-screen text-white flex-col gap-4">
        <p className="text-xl">No URL provided.</p>
        <button
          onClick={() => router.push("/")}
          className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-500"
        >
          Go Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen w-full bg-neutral-950 text-white font-sans overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-2 p-2 bg-neutral-900 border-b border-neutral-800 shadow-md z-10 w-full h-14 flex-shrink-0">
        <button
          onClick={() => router.push("/")}
          title="Exit"
          className="flex items-center gap-1.5 text-sm text-neutral-400 hover:text-white transition-colors px-2 py-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clipRule="evenodd" />
          </svg>
          Exit
        </button>

        <div className="flex items-center gap-1">
          <button
            title="Back"
            onClick={() => iframeRef.current?.contentWindow?.history.back()}
            className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            title="Forward"
            onClick={() => iframeRef.current?.contentWindow?.history.forward()}
            className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            title="Reload"
            onClick={() => iframeRef.current?.contentWindow?.location.reload()}
            className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clipRule="evenodd" />
            </svg>
          </button>
        </div>

        <form
          className="flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(input);
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            spellCheck={false}
            placeholder="Search or enter address"
            className="w-full bg-neutral-800 border border-neutral-700 rounded-full px-4 py-2 text-sm text-neutral-200 focus:outline-none focus:border-indigo-500"
          />
        </form>

        <button
          onClick={openInRealBrowser}
          title="Open in real browser (for logins)"
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-indigo-300 bg-indigo-600/20 border border-indigo-500/40 hover:bg-indigo-600/40 transition-colors whitespace-nowrap"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l2.197-1.32a1 1 0 00.555-.832V8a1 1 0 00-.555-.832l-2.197-1.32a1 1 0 00-.555 0z" clipRule="evenodd" />
          </svg>
          Real browser
        </button>

        <button
          onClick={openInNewTab}
          title="Open in new tab"
          className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
            <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
          </svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 w-full relative bg-white">
        {status === "loading" && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-300">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-500" />
            <p className="text-sm">Starting proxy…</p>
          </div>
        )}

        {status === "error" && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-neutral-950 text-center px-6">
            <p className="text-lg font-semibold text-red-400">Could not start the proxy</p>
            <p className="text-sm text-neutral-400 max-w-md break-words">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-500 text-sm"
            >
              Retry
            </button>
          </div>
        )}

        {frame && (
          <iframe
            key={frame.key}
            ref={iframeRef}
            src={frame.src}
            onLoad={handleFrameLoad}
            title="Browsed content"
            className="absolute inset-0 w-full h-full border-none"
            sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-presentation"
            allow="clipboard-read; clipboard-write; fullscreen; autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        )}
      </div>
    </div>
  );
}

export default function BrowsePage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-full flex items-center justify-center bg-black text-white">
          Loading…
        </div>
      }
    >
      <BrowseContent />
    </Suspense>
  );
}
