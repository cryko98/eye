/**
 * /api/threats — Vercel serverless function: live cyber-attack sources for the globe.
 *
 * Data: blocklist.de public lists (IPs reported attacking servers in the last 48 hours, split by
 * service: SSH, mail, web, IMAP, FTP, SIP, bots, brute-force logins; free to use, credit blocklist.de).
 * Each IP is mapped to its country with the RIR delegated-extended statistics (api/_geo.json).
 * Attack TARGETS are not published by any open source, so this endpoint only reports sources.
 *
 * Returns { updated, total, countries: [[cc, name, lat, lon, count, {type: n}]], types: {type: n},
 *           sample: [[maskedIp, cc, type]] }   — cached 30 min in Redis and at the edge.
 */
const GEO = require("./_geo.json");
const LISTS = { ssh: "SSH brute force", apache: "Web attack", mail: "Mail / spam", imap: "IMAP login", ftp: "FTP attack", sip: "VoIP / SIP", bots: "Bot / scraper", bruteforcelogin: "Login brute force", strongips: "Persistent attacker" };
const ORDER = ["strongips", "ssh", "bruteforcelogin", "apache", "sip", "ftp", "imap", "mail", "bots"];
const EXTRA_CENTROIDS = { AX: [60.2, 19.9, "Åland"], BL: [17.9, -62.83, "Saint Barthélemy"], BQ: [12.2, -68.26, "Caribbean Netherlands"], CW: [12.17, -68.99, "Curaçao"], MF: [18.07, -63.05, "Saint Martin"], SS: [7.86, 29.69, "South Sudan"], SX: [18.04, -63.07, "Sint Maarten"] };
const TTL_MS = 30 * 60_000;
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const UA = "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)";

let table = null;
function geoTable() {
  if (table) return table;
  const u32 = (b64) => { const b = Buffer.from(b64, "base64"); return new Uint32Array(b.buffer, b.byteOffset, b.byteLength / 4); };
  table = { starts: u32(GEO.starts), ends: u32(GEO.ends), idx: Buffer.from(GEO.idx, "base64"), cc: GEO.cc };
  return table;
}
function country(ip) {
  const p = ip.split("."); if (p.length !== 4) return null;
  const n = ((+p[0]) * 16777216) + ((+p[1]) << 16) + ((+p[2]) << 8) + (+p[3]);
  const t = geoTable(); let lo = 0, hi = t.starts.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (t.starts[mid] <= n) lo = mid + 1; else hi = mid - 1; }
  return hi >= 0 && n <= t.ends[hi] ? t.cc[t.idx[hi]] : null;
}
async function redis(...cmd) {
  if (!KV_URL) return null;
  try { const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(5000) }); return (await r.json()).result ?? null; } catch { return null; }
}
async function build() {
  const typeOf = new Map();
  const results = await Promise.allSettled(ORDER.map(async (l) => {
    const r = await fetch(`https://lists.blocklist.de/lists/${l}.txt`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`${l} ${r.status}`);
    return [l, (await r.text()).split(/\r?\n/).filter((x) => /^\d+\.\d+\.\d+\.\d+$/.test(x))];
  }));
  for (const res of results) if (res.status === "fulfilled") { const [l, ips] = res.value; for (const ip of ips) if (!typeOf.has(ip) || ORDER.indexOf(l) < ORDER.indexOf(typeOf.get(ip))) typeOf.set(ip, l); }
  if (!typeOf.size) throw new Error("blocklist.de unavailable");
  const byCountry = new Map(), types = {}; const all = [];
  for (const [ip, type] of typeOf) {
    const cc = country(ip); const c = cc && (GEO.centroids[cc] || EXTRA_CENTROIDS[cc]); if (!c) continue;
    let e = byCountry.get(cc); if (!e) { e = { n: 0, t: {} }; byCountry.set(cc, e); }
    e.n++; e.t[type] = (e.t[type] || 0) + 1; types[type] = (types[type] || 0) + 1;
    all.push([ip.replace(/\.\d+$/, ".x"), cc, type]);
  }
  // shuffle, keep a sample for the live replay
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  const countries = [...byCountry.entries()].map(([cc, e]) => { const c = GEO.centroids[cc] || EXTRA_CENTROIDS[cc]; return [cc, c[2], c[0], c[1], e.n, e.t]; }).sort((a, b) => b[4] - a[4]);
  return JSON.stringify({ updated: Date.now(), total: all.length, countries, types, labels: LISTS, sample: all.slice(0, 2500), source: "blocklist.de (last 48 h) · RIR delegation statistics" });
}
function send(res, status, body, maxAge) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", status >= 400 ? "no-store" : `public, s-maxage=${maxAge}, stale-while-revalidate=3600, max-age=300`);
  res.end(body);
}
let mem = { t: 0, body: null }; let inflight = null;
module.exports = async function handler(req, res) {
  if (!mem.body) { const s = await redis("GET", "threats:v1"); if (s) { try { mem = JSON.parse(s); } catch {} } }
  const fresh = mem.body && Date.now() - mem.t < TTL_MS;
  if (mem.body && !fresh) inflight ||= build().then(async (body) => { mem = { t: Date.now(), body }; await redis("SET", "threats:v1", JSON.stringify(mem), "EX", 6 * 3600); return body; }).catch(() => null).finally(() => { inflight = null; });
  if (mem.body) return send(res, 200, mem.body, 900);
  try {
    inflight ||= build().then(async (body) => { mem = { t: Date.now(), body }; await redis("SET", "threats:v1", JSON.stringify(mem), "EX", 6 * 3600); return body; }).finally(() => { inflight = null; });
    return send(res, 200, await inflight, 900);
  } catch (e) { return send(res, 502, JSON.stringify({ error: String(e.message || e).slice(0, 160) }), 0); }
};
