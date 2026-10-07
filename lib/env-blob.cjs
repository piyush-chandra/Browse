// Resolve Vercel Blob credentials from the environment.
//
// Two supported modes (first available wins):
//   1. "token" — a static read/write token. Standard name BLOB_READ_WRITE_TOKEN;
//      also accepts any *_READ_WRITE_TOKEN (the suffix is Blob-specific:
//      KV uses *_REST_API_TOKEN, Postgres uses *_URL, etc.). This covers
//      stores connected with a custom env prefix.
//   2. "oidc" — no static token at all. The @vercel/blob SDK mints scoped
//      credentials at call time from VERCEL_OIDC_TOKEN (auto-injected on
//      Vercel) + the store id. Standard name BLOB_STORE_ID; also accepts
//      any *_STORE_ID for custom-prefix connects.
//
// Callers pass blobAuthArgs() straight into every SDK call (put/list/del/
// get); the SDK picks token-first, OIDC-second by itself.

let resolved = null; // { mode, token?, storeId?, tokenKey?, storeKey? } | null

function findEnv(suffixRe) {
  return (
    Object.keys(process.env)
      .filter((k) => suffixRe.test(k) && process.env[k])
      .sort()[0] || null
  );
}

function resolveBlobAuth() {
  if (resolved) return resolved;
  const tokenKey =
    (process.env.BLOB_READ_WRITE_TOKEN && "BLOB_READ_WRITE_TOKEN") ||
    findEnv(/^[A-Z0-9_]*_READ_WRITE_TOKEN$/);
  const storeKey =
    (process.env.BLOB_STORE_ID && "BLOB_STORE_ID") ||
    findEnv(/^[A-Z0-9_]*_STORE_ID$/);
  if (tokenKey) {
    resolved = {
      mode: "token",
      token: process.env[tokenKey],
      tokenKey,
      storeId: storeKey ? process.env[storeKey] : undefined,
      storeKey: storeKey || undefined,
    };
    if (tokenKey !== "BLOB_READ_WRITE_TOKEN") {
      console.warn(
        `[blob] BLOB_READ_WRITE_TOKEN not set; using ${tokenKey} instead ` +
          `(store was connected with a custom env prefix — reconnect with the default BLOB prefix to silence this)`
      );
    }
    return resolved;
  }
  if (storeKey) {
    // No static token: the SDK will use VERCEL_OIDC_TOKEN (automatic on
    // Vercel) + this store id. Nothing to copy from the dashboard.
    resolved = {
      mode: "oidc",
      storeId: process.env[storeKey],
      storeKey,
    };
    return resolved;
  }
  return null;
}

// Args to spread into every @vercel/blob SDK call.
function blobAuthArgs() {
  const r = resolveBlobAuth();
  if (!r) return {};
  const args = {};
  if (r.token) args.token = r.token;
  if (r.storeId) args.storeId = r.storeId;
  return args;
}

function blobToken() {
  const r = resolveBlobAuth();
  return r && r.token ? r.token : null;
}

function blobTokenKey() {
  const r = resolveBlobAuth();
  return r && r.tokenKey ? r.tokenKey : null;
}

function blobMode() {
  const r = resolveBlobAuth();
  return r ? r.mode : null;
}

function blobStoreKey() {
  const r = resolveBlobAuth();
  return r && r.storeKey ? r.storeKey : null;
}

module.exports = {
  resolveBlobAuth,
  blobAuthArgs,
  blobToken,
  blobTokenKey,
  blobMode,
  blobStoreKey,
};
