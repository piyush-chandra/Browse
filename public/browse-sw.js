self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

self.addEventListener('fetch', (event) => {
  const reqUrl = new URL(event.request.url);
  const browseOrigin = location.origin;

  // Ignore requests to our own API and Next.js internal files
  if (
    reqUrl.pathname.startsWith('/api/') || 
    reqUrl.pathname.startsWith('/_next/') || 
    reqUrl.pathname === '/' ||
    reqUrl.pathname === '/browse' // Ignore the browse page itself
  ) {
    return;
  }

  // Handle direct requests to external sites (e.g. absolute URLs in the HTML)
  if (reqUrl.origin !== browseOrigin) {
    event.respondWith(
      fetch(`${browseOrigin}/api/browse?url=${encodeURIComponent(event.request.url)}`, {
        method: event.request.method,
        headers: event.request.headers,
        redirect: 'manual'
      }).catch(err => {
        console.error("SW Browse Error for external URL:", err);
        return new Response("Service Worker Browse Error", { status: 500 });
      })
    );
    return;
  }

  // Handle relative URLs that got resolved to our browse origin
  // We extract the target origin from the referrer
  let targetOrigin = null;
  const referrer = event.request.referrer;
  if (referrer) {
    try {
      const refUrl = new URL(referrer);
      const urlParam = refUrl.searchParams.get('url');
      if (urlParam) {
        targetOrigin = new URL(urlParam).origin;
      }
    } catch(e) {
      console.warn("SW Error parsing referrer:", e);
    }
  }

  if (targetOrigin) {
    const browsedUrl = `${targetOrigin}${reqUrl.pathname}${reqUrl.search}`;
    event.respondWith(
      fetch(`${browseOrigin}/api/browse?url=${encodeURIComponent(browsedUrl)}`, {
         method: event.request.method,
         headers: event.request.headers,
         redirect: 'manual'
      }).catch(err => {
        return new Response(`Failed to browse ${browsedUrl}`, { status: 500 });
      })
    );
  }
});
