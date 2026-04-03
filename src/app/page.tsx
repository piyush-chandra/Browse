"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";

export default function Home() {
  const [url, setUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [customCookies, setCustomCookies] = useState("");
  const [customLS, setCustomLS] = useState("");
  const router = useRouter();

  useEffect(() => {
    // Register Service Worker
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker
        .register("/browse-sw.js")
        .then((reg) => console.log("Service Worker registered successfully.", reg.scope))
        .catch((err) => console.error("Service Worker registration failed:", err));
    }
  }, []);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!url) return;
    
    let target = url;
    if (!target.startsWith("http://") && !target.startsWith("https://")) {
      target = "https://" + target;
    }

    if (customCookies) {
      document.cookie = `inject_cookies=${encodeURIComponent(customCookies)}; path=/; max-age=86400`;
    }
    if (customLS) {
      document.cookie = `inject_ls=${encodeURIComponent(customLS)}; path=/; max-age=86400`;
    }
    
    router.push(`/browse?url=${encodeURIComponent(target)}`);
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

          <div className="mt-4 relative z-20">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-sm font-medium text-neutral-400 hover:text-white transition-colors flex items-center justify-center w-full"
            >
              {showAdvanced ? "Hide Advanced Options" : "Session Injection (Bypass Login)"}
            </button>

            {showAdvanced && (
              <div className="mt-4 p-4 bg-neutral-900 rounded-xl border border-neutral-800 space-y-4 shadow-xl">
                <div>
                  <label className="block text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                    Custom Cookies (String)
                  </label>
                  <input
                    type="text"
                    value={customCookies}
                    onChange={(e) => setCustomCookies(e.target.value)}
                    placeholder="session_id=1234; auth_token=abcd;"
                    className="w-full bg-neutral-950 border border-neutral-700 rounded-lg text-sm text-white px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[10px] text-neutral-500 mt-1">
                    Will be sent in the headers to the target server to mimic an authenticated session.
                  </p>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-400 uppercase tracking-wider mb-2">
                    LocalStorage (JSON)
                  </label>
                  <textarea
                    value={customLS}
                    onChange={(e) => setCustomLS(e.target.value)}
                    placeholder='{"token": "abcdef123"}'
                    rows={3}
                    className="w-full bg-neutral-950 border border-neutral-700 rounded-lg text-sm text-white px-3 py-2 focus:outline-none focus:border-indigo-500"
                  />
                  <p className="text-[10px] text-neutral-500 mt-1">
                    Will be injected dynamically into the window.localStorage of the proxied app.
                  </p>
                </div>
              </div>
            )}
          </div>
        </form>

        <div className="mt-8 text-center text-sm text-neutral-500">
          <p>Powered by Next.js Edge & Service Workers.</p>
          <p>Deploy seamlessly on Vercel.</p>
        </div>
      </div>
    </div>
  );
}
