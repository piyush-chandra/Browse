"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

import {
  PREFIX,
  initProxy,
  normalizeUrl,
} from "@/lib/proxy-boot";

// Proxy boot (service-worker registration, bare-mux transport) lives in
// @/lib/proxy-boot so the /service/ cold-load route can reuse it.

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
  const [showTip, setShowTip] = useState(true);

  // Some flows can't survive the fast proxy, and they fail confusingly
  // (silent dead buttons, blank players). Name the problem in the UI and
  // offer the one-click handoff to the real browser:
  // - YouTube: googlevideo.com 403s cloud egress → player stays blank.
  // - Google sign-in: the login request is rejected from proxied pages.
  // - GitHub login pages: OAuth/API handshakes break under rewriting.
  const tip: { title: string; body: string } | null = (() => {
    try {
      const u = new URL(address);
      const host = u.hostname.toLowerCase();
      if (host === "youtu.be" || /(^|\.)youtube\.com$/.test(host)) {
        return {
          title: "YouTube blocks video playback through proxies",
          body: "the page loads but the player stays blank. Use the real browser for actual playback.",
        };
      }
      if (host === "accounts.google.com") {
        return {
          title: "Google sign-in can't complete in the fast proxy",
          body: "Google rejects the login request from proxied pages. Continue in the real browser instead.",
        };
      }
      if (host === "github.com" && u.pathname.toLowerCase().startsWith("/login")) {
        return {
          title: "GitHub login may fail in the fast proxy",
          body: "login handshakes often break under proxy rewriting. If sign-in stalls, continue in the real browser.",
        };
      }
      return null;
    } catch {
      return null;
    }
  })();

  useEffect(() => {
    setShowTip(true);
  }, [address]);

  // Boot the proxy, then point the iframe at the encoded target.
  // A health preflight runs first so backend problems (missing proxy
  // files, wrong start command) show an actionable error instead of a
  // spinner. See /api/health for the full diagnostic.
  useEffect(() => {
    if (!initialUrl) return;
    let cancelled = false;

    (async () => {
      // Preflight: fail fast with an actionable message if the backend
      // isn't right (missing files / wrong start command). If the check
      // itself is unreachable, fall through to initProxy's own timeouts.
      try {
        const res = await fetch("/api/health");
        if (res.ok) {
          const health = (await res.json()) as {
            assets?: { ok: boolean; missing?: string[]; hint?: string };
            bare?: { ok: boolean; hint?: string };
          };
          if (health.assets && !health.assets.ok) {
            throw new Error(
              `${health.assets.hint || "Proxy files missing."} Missing: ${(health.assets.missing || []).join(", ")}`
            );
          }
          if (health.bare && !health.bare.ok) {
            throw new Error(health.bare.hint || "Proxy backend unreachable.");
          }
        }
      } catch (err) {
        if (err instanceof Error && !err.message.toLowerCase().includes("fetch")) throw err;
        // health endpoint unreachable — continue; initProxy will time out clearly.
      }
      await initProxy();
    })()
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
  // Direct navigation (no POST): the /remote page's WebSocket creates the
  // session lazily on whichever instance holds the stream — the reliable
  // path on Fluid-style hosts where HTTP and WS can land on different
  // instances.
  const openInRealBrowser = useCallback(
    (targetUrl?: string, sessionName?: string) => {
      const goto = targetUrl || address;
      if (!goto) return;
      const id = sessionName || "main";
      router.push(
        `/remote?session=${encodeURIComponent(id)}&url=${encodeURIComponent(goto)}`
      );
    },
    [address, router]
  );

  // One-click Google sign-in: opens the REAL browser (fast proxy provably
  // can't do Google logins) on a dedicated "google" session whose profile
  // is persisted to external storage when configured, and carries the user
  // back to where they were after sign-in (Google usually re-lands you on
  // the site itself; otherwise doesGoogleNav below).
  const openGoogleSignIn = useCallback(() => {
    void openInRealBrowser(address, "google");
  }, [address, openInRealBrowser]);

  const isOAuthSite = (() => {
    try {
      const host = new URL(address).hostname.toLowerCase();
      return /(^|\.)neetcode\.io$/.test(host) || /(^|\.)leetcode\.com$/.test(host);
    } catch {
      return false;
    }
  })();

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
          onClick={() => openInRealBrowser()}
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

        {isOAuthSite && (
          <button
            onClick={openGoogleSignIn}
            title="Sign in with Google in the real browser — the google session's profile is saved when profile storage is configured, so you stay logged in"
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-white bg-[#4285F4]/90 hover:bg-[#4285F4] transition-colors whitespace-nowrap"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path fill="#ffffff" d="M12.48 10.92v3.28h7.84c-.24 1.85-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z" />
            </svg>
            Sign in with Google
          </button>
        )}
      </div>

      {/* Content */}
      {status === "ready" && tip && showTip && (
        <div className="flex items-center gap-3 px-4 py-2 bg-amber-500/10 border-b border-amber-500/30 text-amber-200 text-xs flex-shrink-0">
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          <p className="flex-1">
            {tip.title} — {tip.body}
          </p>
          <button
            onClick={() => openInRealBrowser()}
            className="px-2.5 py-1 rounded-md font-medium text-black bg-amber-300 hover:bg-amber-200 transition-colors whitespace-nowrap"
          >
            Open in Real browser
          </button>
          <button
            onClick={() => setShowTip(false)}
            title="Dismiss"
            className="p-1 rounded text-amber-300/70 hover:text-amber-100 transition-colors"
          >
            ✕
          </button>
        </div>
      )}
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
