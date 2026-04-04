/**
 * Netlify Blobs: `getStore("name")` relies on NETLIFY_BLOBS_CONTEXT (injected on most
 * HTTP invokes). `@netlify/functions` `schedule()` handlers often omit that context,
 * which throws MissingBlobsEnvironmentError. When context is absent, fall back to
 * explicit siteID + token (NETLIFY_BLOB_TOKEN or NETLIFY_TOKEN with Blobs scope).
 */
const { getStore: nativeGetStore } = require("@netlify/blobs");

function hasBlobsContext() {
  return (
    typeof process.env.NETLIFY_BLOBS_CONTEXT === "string" &&
    process.env.NETLIFY_BLOBS_CONTEXT.length > 0
  );
}

function getStore(input) {
  if (typeof input === "string") {
    if (hasBlobsContext()) {
      return nativeGetStore(input);
    }
    const siteID = process.env.NETLIFY_SITE_ID;
    const token =
      process.env.NETLIFY_BLOB_TOKEN ||
      process.env.NETLIFY_AUTH_TOKEN ||
      process.env.NETLIFY_TOKEN;
    if (siteID && token) {
      return nativeGetStore({ name: input, siteID, token });
    }
    return nativeGetStore(input);
  }
  return nativeGetStore(input);
}

module.exports = { getStore };
