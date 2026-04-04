/**
 * Optional off-hours test: set SCAN_FORCE_SECRET in Netlify env, then POST with
 * ?force=<same secret> or header X-Scan-Force: <same secret>.
 * Never commit the secret; rotate if leaked.
 */
function isScanForceRequested(event) {
  const secret = process.env.SCAN_FORCE_SECRET;
  if (!secret || !event || typeof event !== "object") return false;
  const qp = event.queryStringParameters || {};
  if (qp.force === secret) return true;
  const headers = event.headers || {};
  const h = headers["x-scan-force"] || headers["X-Scan-Force"] || "";
  return h === secret;
}

module.exports = { isScanForceRequested };
