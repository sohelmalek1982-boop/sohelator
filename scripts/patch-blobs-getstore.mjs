import fs from "fs";
import path from "path";

function walk(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    if (f === "node_modules" || f === ".git") continue;
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|cjs)$/.test(f)) out.push(p);
  }
}

const roots = ["netlify/functions", "src/lib"];
const files = [];
for (const r of roots) walk(r, files);

let changed = 0;
for (const file of files) {
  let s = fs.readFileSync(file, "utf8");
  const orig = s;

  s = s.replace(
    /getStore\(\{\s*name:\s*['"]([^'"]+)['"]\s*,\s*siteID:\s*process\.env\.NETLIFY_SITE_ID\s*,\s*token:\s*process\.env\.NETLIFY_TOKEN\s*,\s*\}\)/g,
    "getStore('$1')"
  );
  s = s.replace(
    /getStore\(\{\s*name:\s*['"]([^'"]+)['"]\s*,\s*siteID\s*,\s*token\s*,\s*\}\)/g,
    "getStore('$1')"
  );
  s = s.replace(
    /getStore\(\{\s*name:\s*['"]([^'"]+)['"]\s*,\s*siteID:\s*process\.env\.NETLIFY_SITE_ID\s*,\s*token:\s*process\.env\.NETLIFY_TOKEN\s*\}\)/g,
    "getStore('$1')"
  );

  if (s !== orig) {
    fs.writeFileSync(file, s);
    changed++;
    console.log("updated", file);
  }
}
console.log("files changed:", changed);
