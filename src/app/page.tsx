"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"fast" | "real">("fast");
  const router = useRouter();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;

    let target = url.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) {
      target = "https://" + target;
    }

    if (mode === "real") {
      router.push(`/remote?url=${encodeURIComponent(target)}`);
    } else {
      router.push(`/browse?url=${encodeURIComponent(target)}`);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex flex-col items-center justify-center p-4 relative overflow-hidden font-sans text-white">
      {/* Background Glows */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-indigo-600/30 rounded-full blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-fuchsia-600/20 rounded-full blur-[120px] pointer-events-none"></div>

      <div className="z-10 w-full max-w-lg">
        <div className="text-center mb-10">
          <h1 className="text-5xl font-extrabold tracking-tight mb-4 bg-gradient-to-r from-indigo-400 to-cyan-400 text-transparent bg-clip-text animate-pulse">
            Browse
          </h1>
          <p className="text-neutral-400 text-lg">
            A seamless bridge to the decentralized web. Access any site securely.
          </p>
        </div>

        <div className="flex items-center justify-center gap-2 mb-6">
          <button
            type="button"
            onClick={() => setMode("fast")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              mode === "fast"
                ? "bg-white text-black"
                : "bg-neutral-900 text-neutral-400 border border-neutral-800 hover:text-white"
            }`}
          >
            Fast proxy
          </button>
          <button
            type="button"
            onClick={() => setMode("real")}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${
              mode === "real"
                ? "bg-white text-black"
                : "bg-neutral-900 text-neutral-400 border border-neutral-800 hover:text-white"
            }`}
          >
            Real browser
          </button>
        </div>
        <p className="text-center text-xs text-neutral-500 mb-6 -mt-3">
          {mode === "fast"
            ? "Quick browsing through the Ultraviolet proxy."
            : "A real Chromium for logins (Google/GitHub), captchas and bot checks. Logins persist."}
        </p>

        <form onSubmit={handleSubmit} className="relative">
          <div className="relative group">
            <div className="absolute -inset-0.5 bg-gradient-to-r from-indigo-500 to-fuchsia-500 rounded-2xl blur opacity-30 group-hover:opacity-60 transition duration-500 pointer-events-none"></div>
            <div className="relative flex items-center bg-neutral-900 rounded-2xl p-2 border border-neutral-800 shadow-2xl">
              <div className="pl-4 text-neutral-500">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9" />
                </svg>
              </div>
              <input
                type="text"
                className="w-full bg-transparent border-none text-white px-4 py-3 focus:outline-none placeholder-neutral-500 text-lg"
                placeholder="https://example.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                required
              />
              <button
                type="submit"
                className="bg-white text-black font-semibold px-6 py-3 rounded-xl hover:bg-neutral-200 transition-colors transform active:scale-95 duration-200"
              >
                Launch
              </button>
            </div>
          </div>
        </form>

        {/* Blocked-Google escape hatch: company laptops that block Google
            sign-in still work here, because the login happens on the
            server's real Chrome, not on this machine. Profile persists in
            external storage when configured. */}
        <div className="mt-5 flex justify-center">
          <button
            type="button"
            onClick={() =>
              router.push(
                `/remote?session=google&url=${encodeURIComponent("https://accounts.google.com/")} `
                  .trim()
              )
            }
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium text-white bg-neutral-900 border border-neutral-700 hover:border-neutral-500 transition-colors"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
              <path fill="#EA4335" d="M12 5.3c1.7 0 3 .7 3.9 1.6l2.9-2.9C17 2.2 14.7 1.2 12 1.2 7.9 1.2 4.3 3.6 2.6 7.1l3.4 2.6C6.8 7.1 9.2 5.3 12 5.3z" />
              <path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.4h6c-.3 1.4-1 2.5-2.1 3.3l3.3 2.6c2-1.8 3.4-4.6 3.4-8.1z" />
              <path fill="#FBBC05" d="M6 14.3c-.3-.8-.4-1.5-.4-2.3s.2-1.6.4-2.3L2.6 7.1C1.8 8.6 1.3 10.3 1.3 12s.5 3.4 1.3 4.9l3.4-2.6z" />
              <path fill="#34A853" d="M12 22.8c3.1 0 5.7-1 7.2-2.8l-3.3-2.6c-.9.6-2.2 1.1-3.9 1.1-2.8 0-5.2-1.9-6-4.4l-3.4 2.6c1.7 3.6 5.3 6.1 9.4 6.1z" />
            </svg>
            Sign in with Google (server-side)
          </button>
        </div>
        <p className="text-center text-[11px] text-neutral-600 mt-2">
          For laptops where Google sign-in is blocked: the login runs on the server&apos;s Chrome,
          then the saved profile keeps you signed in everywhere.
        </p>
      </div>
    </div>
  );
}
