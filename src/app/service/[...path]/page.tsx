"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { decodeServicePath, initProxy } from "@/lib/proxy-boot";

/**
 * Cold-loaded /service/<encoded-url> handler.
 *
 * When the Ultraviolet service worker already controls this origin it
 * intercepts /service/… requests itself and Next never sees them. This
 * route only runs on a cold load (shared/bookmarked link, fresh browser):
 * it boots the proxy (registers the SW at root scope + configures the
 * bare-mux transport) and reloads once, so the second load is intercepted
 * by the worker and the proxied page renders.
 */
function ServiceBoot() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<string>("this page");

  useEffect(() => {
    let cancelled = false;
    initProxy()
      .then(() => {
        if (cancelled) return;
        // Ultraviolet is loaded now, so the target URL can be shown briefly.
        const decoded = decodeServicePath(window.location.pathname);
        if (decoded) setTarget(decoded);
        // Give the UI one frame, then reload under SW control.
        setTimeout(() => window.location.reload(), 150);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return (
      <div className="flex bg-neutral-950 items-center justify-center min-h-screen text-white flex-col gap-4 px-6 text-center">
        <p className="text-lg font-semibold text-red-400">Could not start the proxy</p>
        <p className="text-sm text-neutral-400 max-w-md break-words">{error}</p>
        <div className="flex gap-2">
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-500 text-sm"
          >
            Retry
          </button>
          <button
            onClick={() => router.push("/")}
            className="px-4 py-2 bg-neutral-800 border border-neutral-700 rounded-lg hover:bg-neutral-700 text-sm"
          >
            Home
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex bg-neutral-950 items-center justify-center min-h-screen text-white flex-col gap-4 px-6 text-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-500" />
      <p className="text-sm text-neutral-300">Starting proxy…</p>
      <p className="text-xs text-neutral-500 max-w-md break-all">{target}</p>
    </div>
  );
}

export default function ServiceBootPage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-full flex items-center justify-center bg-black text-white">
          Loading…
        </div>
      }
    >
      <ServiceBoot />
    </Suspense>
  );
}
