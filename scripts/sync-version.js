#!/usr/bin/env node
// sync-version.js
// Reads `version` from package.json and rewrites the ?v= query string
// on every <script src="...?v=..."> tag in public/index.html.
// Run automatically via netlify.toml [build] command before each deploy.

const fs   = require("fs");
const path = require("path");

const pkg     = require("../package.json");
const version = pkg.version;

const htmlPath = path.join(__dirname, "../public/index.html");
let html       = fs.readFileSync(htmlPath, "utf8");

// Replace ?v=<anything> on script src attributes
const updated = html.replace(
  /(<script\b[^>]*\bsrc="[^"]+)\?v=[^"]*(")/g,
  `$1?v=${version}$2`
);

if (updated === html) {
  console.log(`[sync-version] ✅ index.html already at ?v=${version} — nothing to change.`);
} else {
  fs.writeFileSync(htmlPath, updated, "utf8");
  console.log(`[sync-version] ✅ index.html script tags updated to ?v=${version}`);
}
