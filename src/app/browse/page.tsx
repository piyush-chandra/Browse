"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { Suspense } from "react";

function BrowseContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const url = searchParams.get("url");

  if (!url) {
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
      {/* Small top bar */}
      <div className="flex items-center justify-between p-2 bg-neutral-900 border-b border-neutral-800 shadow-md z-10 w-full h-12 flex-shrink-0">
        <button
          onClick={() => router.push("/")}
          className="flex items-center gap-2 text-sm text-neutral-400 hover:text-white transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M9.707 14.707a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 1.414L7.414 9H15a1 1 0 110 2H7.414l2.293 2.293a1 1 0 010 1.414z" clipRule="evenodd" />
          </svg>
          Exit
        </button>
        <div className="flex-1 px-4 text-center">
          <div className="inline-block px-3 py-1 bg-neutral-800 rounded-full text-xs font-mono text-neutral-300 truncate max-w-md">
            Browsing: {url}
          </div>
        </div>
        <div className="w-16"></div> {/* Spacer for center alignment */}
      </div>

      {/* Target Iframe */}
      <div className="flex-1 w-full relative bg-white">
        <iframe
          src={`/api/browse?url=${encodeURIComponent(url)}`}
          className="absolute inset-0 w-full h-full border-none"
          title="Browsed Content"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals"
        />
      </div>
    </div>
  );
}

export default function BrowsePage() {
  return (
    <Suspense fallback={<div className="h-screen w-full flex items-center justify-center bg-black text-white">Loading...</div>}>
      <BrowseContent />
    </Suspense>
  );
}
