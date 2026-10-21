// Local dev server: serves the static site and mounts /api/* like Vercel does.
// Usage: node dev-server.js  →  http://localhost:5173
const http = require("http");
const fs = require("fs");
const path = require("path");

// Local env (.env.local is git-ignored): KEY=value per line.
try {
  for (const line of fs.readFileSync(path.join(__dirname, ".env.local"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
} catch {}

const API = {
  flights: require("./api/flights.js"), estonia: require("./api/estonia.js"), singapore: require("./api/singapore.js"),
  windy: require("./api/windy.js"), news: require("./api/news.js"), hunt: require("./api/hunt.js"), satellites: require("./api/satellites.js"), config: require("./api/config.js"), sweden: require("./api/sweden.js"),
};

const ROOT = __dirname;
const PORT = process.env.PORT || 5173;
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const api = url.pathname.match(/^\/api\/([a-z]+)$/);
  if (api && API[api[1]]) {
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (o) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); };
    try { await API[api[1]](req, res); } catch (e) { res.statusCode = 500; res.end(String(e)); }
    return;
  }
  let p = decodeURIComponent(url.pathname);
  if (p === "/") p = "/index.html";
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404; res.end("not found"); return;
  }
  res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`dev server → http://localhost:${PORT}`));
