// Client helper for APIs guarded by IMPORT_TOKEN (cookie import, vault).
// The token is per-browser (localStorage), attached as a Bearer token.
// On a 401 the user is prompted once and the request retried — so setting
// IMPORT_TOKEN (recommended) doesn't silently break the UI buttons.
const KEY = "browse.importToken";

export function getImportToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearImportToken() {
  try {
    window.localStorage.removeItem(KEY);
  } catch {}
}

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const withAuth = (token: string | null) => {
    const headers = new Headers(init.headers || {});
    if (token) headers.set("authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };

  let res = await withAuth(getImportToken());
  if (res.status === 401 && typeof window !== "undefined") {
    const entered = window.prompt(
      "This deployment is locked with IMPORT_TOKEN.\nPaste the token to continue (stored only in this browser):"
    );
    if (entered && entered.trim()) {
      const token = entered.trim();
      try {
        window.localStorage.setItem(KEY, token);
      } catch {}
      res = await withAuth(token);
      if (res.status === 401) clearImportToken(); // wrong token — don't keep it
    }
  }
  return res;
}
