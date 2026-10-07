// Resolve the Vercel Blob read/write token from the environment.
//
// Standard case: connecting a Blob store to a project injects
// BLOB_READ_WRITE_TOKEN. But Vercel's connect dialog allows a custom env
// prefix (and some flows inject only BLOB_STORE_ID / webhook keys), which
// leaves the app thinking Blob is missing. Fallback: accept any
// *_READ_WRITE_TOKEN key — that suffix is Blob-specific across Vercel
// storage products (KV uses *_REST_API_TOKEN, Postgres uses *_URL, etc.).

let resolved = null; // { key, value } | null — resolved once per process

function resolveBlobToken() {
  if (resolved) return resolved;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    resolved = { key: "BLOB_READ_WRITE_TOKEN", value: process.env.BLOB_READ_WRITE_TOKEN };
    return resolved;
  }
  const alt = Object.keys(process.env)
    .filter((k) => /^[A-Z0-9_]*_READ_WRITE_TOKEN$/.test(k) && process.env[k])
    .sort();
  if (alt.length > 0) {
    resolved = { key: alt[0], value: process.env[alt[0]] };
    console.warn(
      `[blob] BLOB_READ_WRITE_TOKEN not set; using ${alt[0]} instead ` +
        `(store was connected with a custom env prefix — reconnect with the default BLOB prefix to silence this)`
    );
    return resolved;
  }
  return null;
}

function blobToken() {
  const r = resolveBlobToken();
  return r ? r.value : null;
}

function blobTokenKey() {
  const r = resolveBlobToken();
  return r ? r.key : null;
}

module.exports = { resolveBlobToken, blobToken, blobTokenKey };
