import { NextRequest, NextResponse } from "next/server";

export const runtime = "edge"; // Run on Edge for better browse streaming

export async function GET(req: NextRequest) {
  return handleRequest(req);
}
export async function POST(req: NextRequest) {
  return handleRequest(req);
}
export async function PUT(req: NextRequest) {
  return handleRequest(req);
}
export async function DELETE(req: NextRequest) {
  return handleRequest(req);
}

async function handleRequest(req: NextRequest) {
  const urlParams = new URL(req.url);
  const targetUrl = urlParams.searchParams.get("url");

  if (!targetUrl) {
    return NextResponse.json(
      { error: "Target URL is required. Add ?url=<your_target_url>" },
      { status: 400 }
    );
  }

  try {
    const target = new URL(targetUrl);
    const headers = new Headers(req.headers);

    // Remove headers that might cause the target server to reject the browse request
    headers.delete("host");
    headers.delete("referer");
    headers.set("origin", target.origin);

    // Inject Custom Cookies
    const injectCookies = req.cookies.get("inject_cookies")?.value;
    if (injectCookies) {
      const decoded = decodeURIComponent(injectCookies);
      const existing = headers.get("cookie");
      headers.set("cookie", existing ? `${existing}; ${decoded}` : decoded);
    }

    const init: RequestInit = {
      method: req.method,
      headers,
      redirect: "manual",
    };

    // Add body for non-GET/HEAD requests
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = await req.blob();
    }

    const response = await fetch(target.toString(), init);

    // Forward the response back to the client
    const resHeaders = new Headers(response.headers);
    
    // Remove headers that prevent iframe embedding or break browsing
    resHeaders.delete("x-frame-options");
    resHeaders.delete("content-security-policy");
    resHeaders.delete("strict-transport-security");

    // Rewrite Set-Cookie to work on our domain (optional: can be enhanced)
    const setCookie = resHeaders.get("set-cookie");
    if (setCookie) {
      // Very basic cookie passing; depending on SameSite, this might need more modification
      resHeaders.set(
        "set-cookie",
        setCookie.replace(/domain=[^;]+;/gi, "")
      );
    }

    // CORS headers just in case we fetch this endpoint directly from the browser
    resHeaders.set("access-control-allow-origin", "*");
    resHeaders.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");

    // Rewrite Base tag logic: if it's returning HTML, we inject the base tag.
    let body = response.body;
    const contentType = response.headers.get("content-type") || "";
    
    if (contentType.includes("text/html")) {
      // Using TextDecoderStream and TextEncoderStream to inject <base> head tag into HTML
      const transformStream = new TransformStream({
        transform(chunk, controller) {
          const text = new TextDecoder().decode(chunk);
          if (text.includes("<head>")) {
            // Compute base to browse endpoint
            const browseBase = `${urlParams.origin}/api/browse?url=${target.origin}/`;
            // Base tag injection makes relative paths hit origin. But we want absolute browse paths!
            // Actually, <base href="https://target.com/"> makes everything hit target.com directly.
            // If we want browsing, we leave it, and ServiceWorker intercepts it.
            // Prepare LocalStorage injection if present
            const injectLs = req.cookies.get("inject_ls")?.value;
            let lsScript = "";
            if (injectLs) {
              const decoded = decodeURIComponent(injectLs);
              lsScript = `
                try {
                  const lsData = JSON.parse(String.raw\`${decoded.replace(/`/g, "\\`").replace(/\$/g, "\\$")}\`);
                  for(let key in lsData) {
                    window.localStorage.setItem(key, typeof lsData[key] === 'object' ? JSON.stringify(lsData[key]) : lsData[key]);
                  }
                  console.log('Session injected into LocalStorage');
                } catch(e) { console.error('LS Inject Error', e); }
              `;
            }

            // Inject a service worker registrar right into the head:
            const swInject = `<script>
              if ('serviceWorker' in navigator) {
                window.addEventListener('load', function() {
                  navigator.serviceWorker.register('/browse-sw.js').then(function(registration) {
                    console.log('SW registered with scope:', registration.scope);
                  }, function(err) {
                    console.log('SW registration failed:', err);
                  });
                });
              }
              window.BROWSE_TARGET = "${target.origin}";
              ${lsScript}
            </script>`;
            controller.enqueue(new TextEncoder().encode(text.replace("<head>", `<head>${swInject}`)));
          } else {
            controller.enqueue(chunk);
          }
        }
      });
      // Pipe the body through the transform stream if body exists
      if (body) {
        body = body.pipeThrough(transformStream);
      }
    }

    return new NextResponse(body, {
      status: response.status,
      statusText: response.statusText,
      headers: resHeaders,
    });
  } catch (error: any) {
    console.error("Browse Error:", error);
    return NextResponse.json(
      { error: "Failed to fetch resource", details: error.message },
      { status: 500 }
    );
  }
}
