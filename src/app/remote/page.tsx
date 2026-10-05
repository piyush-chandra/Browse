"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

// Must match VIEWPORT in lib/remote-manager.cjs.
const VIEWPORT = { width: 1280, height: 800 };

type Status = "starting" | "live" | "disconnected" | "error";

function send(ws: WebSocket | null, obj: unknown) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function RemoteContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionParam = searchParams.get("session") || "main";
  const urlParam = searchParams.get("url") || "";

  const [sessionId, setSessionId] = useState(sessionParam);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>("starting");
  const [pageUrl, setPageUrl] = useState("");
  const [pageTitle, setPageTitle] = useState("");
  const [input, setInput] = useState(urlParam);
  const [notice, setNotice] = useState<string | null>(null);
  const [profileState, setProfileState] = useState<string | null>(null);

  // Profile-storage status (external persistence for the session's Chrome
  // profile). Surfaced in the toolbar so "will my login survive?" is
  // answerable at a glance.
  useEffect(() => {
    fetch("/api/remote/profile")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setProfileState(d.configured ? String(d.provider) : "local disk");
      })
      .catch(() => {});
  }, []);

  const imgRef = useRef<HTMLImageElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastMoveRef = useRef(0);

  // 1. Ensure the server-side browser session exists.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/remote/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: sessionParam, url: urlParam || undefined }),
    })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        if (!cancelled) {
          setSessionId(data.sessionId);
          setReady(true);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setNotice(err instanceof Error ? err.message : String(err));
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [sessionParam, urlParam]);

  // 2. Stream frames + page state over WebSocket.
  useEffect(() => {
    if (!ready) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/remote-ws?sessionId=${encodeURIComponent(sessionId)}`
    );
    wsRef.current = ws;
    ws.onopen = () => setStatus("live");
    ws.onclose = () => {
      setStatus("disconnected");
      wsRef.current = null;
    };
    ws.onerror = () => setStatus("error");
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data));
        if (msg.type === "frame") {
          if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.type === "nav" || msg.type === "hello") {
          setPageUrl(msg.url || "");
          setPageTitle(msg.title || "");
          setInput(msg.url || "");
        } else if (msg.type === "error") {
          setNotice(String(msg.message || "remote error"));
        }
      } catch {
        // ignore malformed frames
      }
    };
    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [ready, sessionId]);

  const toViewport = useCallback((clientX: number, clientY: number) => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.round(((clientX - rect.left) * VIEWPORT.width) / rect.width),
      y: Math.round(((clientY - rect.top) * VIEWPORT.height) / rect.height),
    };
  }, []);

  const navigate = useCallback(
    (raw: string) => {
      let target = raw.trim();
      if (!target) return;
      if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) target = `https://${target}`;
      setInput(target);
      send(wsRef.current, { type: "navigate", url: target });
    },
    []
  );

  // Keyboard goes to the remote browser unless typing in our own inputs.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      send(wsRef.current, { type: "keyDown", key: e.key, repeat: e.repeat });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      e.preventDefault();
      send(wsRef.current, { type: "keyUp", key: e.key });
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  // Non-passive wheel listener so the remote page scrolls, not ours.
  useEffect(() => {
    const el = viewerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      send(wsRef.current, { type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ready]);

  const statusColor =
    status === "live"
      ? "bg-emerald-500"
      : status === "starting"
        ? "bg-amber-500 animate-pulse"
        : "bg-red-500";

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
            onClick={() => send(wsRef.current, { type: "back" })}
            className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            title="Forward"
            onClick={() => send(wsRef.current, { type: "forward" })}
            className="p-2 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
            </svg>
          </button>
          <button
            title="Reload"
            onClick={() => send(wsRef.current, { type: "reload" })}
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

        <div className="flex items-center gap-2 px-2" title={pageTitle || pageUrl}>
          <span className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
          <span className="text-xs text-neutral-400 hidden sm:inline">
            {status === "live" ? "Real browser" : status}
            {sessionId !== "main" ? ` · ${sessionId}` : ""}
          </span>
          <span
            className={`hidden md:inline text-xs px-1.5 py-0.5 rounded ${
              profileState === "local disk"
                ? "bg-neutral-800 text-neutral-400"
                : profileState
                  ? "bg-emerald-900/60 text-emerald-300"
                  : ""
            }`}
            title={
              profileState === "local disk"
                ? "Profile persists on this host's disk only — logins may vanish on redeploy/scale-in (ephemeral hosts)"
                : `Profile snapshots to external storage (${profileState}) after navigation — logins survive restarts`
            }
          >
            {profileState === "local disk" ? "profile: local" : profileState ? `profile: ${profileState}` : ""}
          </span>
        </div>
      </div>

      {/* Viewer */}
      <div className="flex-1 w-full relative bg-black flex items-center justify-center overflow-hidden">
        {status !== "live" && (
          <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-neutral-950 text-neutral-300 px-6 text-center">
            {status === "starting" && (
              <>
                <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-700 border-t-indigo-500" />
                <p className="text-sm">Launching real browser… (first run downloads nothing, just starts Chrome)</p>
              </>
            )}
            {(status === "disconnected" || status === "error") && (
              <>
                <p className="text-lg font-semibold text-red-400">
                  {status === "error" ? "Remote browser error" : "Disconnected"}
                </p>
                {notice && <p className="text-sm text-neutral-400 max-w-md break-words">{notice}</p>}
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 bg-indigo-600 rounded-lg hover:bg-indigo-500 text-sm"
                >
                  Reconnect
                </button>
              </>
            )}
          </div>
        )}

        <div
          ref={viewerRef}
          className="relative select-none"
          style={{ width: "min(100%, calc((100vh - 3.5rem) * 1.6))" }}
          onContextMenu={(e) => e.preventDefault()}
          onMouseMove={(e) => {
            const now = performance.now();
            if (now - lastMoveRef.current < 33) return; // ~30hz
            lastMoveRef.current = now;
            const p = toViewport(e.clientX, e.clientY);
            if (p) send(wsRef.current, { type: "mouseMove", ...p });
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            const p = toViewport(e.clientX, e.clientY);
            if (!p) return;
            send(wsRef.current, { type: "mouseMove", ...p });
            send(wsRef.current, { type: "mouseDown", button: e.button });
          }}
          onMouseUp={(e) => {
            const p = toViewport(e.clientX, e.clientY);
            if (p) send(wsRef.current, { type: "mouseMove", ...p });
            send(wsRef.current, { type: "mouseUp", button: e.button });
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            ref={imgRef}
            alt={pageTitle || "Remote browser"}
            className="w-full h-auto block bg-black cursor-default"
            draggable={false}
          />
        </div>
      </div>
    </div>
  );
}

export default function RemotePage() {
  return (
    <Suspense
      fallback={
        <div className="h-screen w-full flex items-center justify-center bg-black text-white">
          Loading…
        </div>
      }
    >
      <RemoteContent />
    </Suspense>
  );
}
