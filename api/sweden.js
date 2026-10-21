/**
 * /api/sweden — Vercel serverless function.
 * Swedish road and road-weather cameras from Trafikverket's open data API (free key from
 * https://data.trafikverket.se/get-started, set as TRAFIKVERKET_API_KEY on Vercel).
 *
 * The camera list changes rarely, so it is stored in Redis (Upstash / Vercel KV) for a day and
 * refreshed in the background every 6 hours. Cold starts serve the stored copy immediately, and
 * a slow or failing Trafikverket API never empties the map.
 *
 * Returns { enabled, total, rows: [[id, name, lat, lon, photoUrl]] }.
 */
const API = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const FRESH_MS = 6 * 3600_000;
const KEEP_S = 7 * 86400;
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
let mem = { t: 0, body: null };
let inflight = null;

async function redis(...cmd) {
  if (!KV_URL) return null;
  try {
    const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd), signal: AbortSignal.timeout(5000) });
    const j = await r.json(); return j.result ?? null;
  } catch { return null; }
}
function send(res, status, body, maxAge) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", status >= 400 ? "no-store" : `public, s-maxage=${maxAge}, stale-while-revalidate=86400, max-age=600`);
  res.end(body);
}
async function fetchList(key) {
  const xml = `<REQUEST><LOGIN authenticationkey="${key}" />` +
    `<QUERY objecttype="Camera" schemaversion="1"><FILTER><EQ name="Active" value="true" /></FILTER>` +
    `<INCLUDE>Id</INCLUDE><INCLUDE>Name</INCLUDE><INCLUDE>PhotoUrl</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE></QUERY></REQUEST>`;
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "text/xml", "User-Agent": "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)" }, body: xml, signal: AbortSignal.timeout(25000) });
  const j = await r.json();
  const result = j?.RESPONSE?.RESULT?.[0] || {};
  if (result.ERROR) throw new Error(`trafikverket: ${result.ERROR.MESSAGE || "error"}`);
  const rows = [];
  for (const c of result.Camera || []) {
    const m = String(c?.Geometry?.WGS84 || "").match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/);
    if (!m || !c.PhotoUrl) continue;
    rows.push([String(c.Id), String(c.Name || "Kamera").slice(0, 60), +(+m[2]).toFixed(5), +(+m[1]).toFixed(5), c.PhotoUrl]);
  }
  if (!rows.length) throw new Error("trafikverket: empty camera list");
  return JSON.stringify({ enabled: true, total: rows.length, rows });
}
async function refresh(key) {
  inflight ||= fetchList(key).then(async (body) => {
    mem = { t: Date.now(), body };
    await redis("SET", "se:cams", JSON.stringify({ t: mem.t, body }), "EX", KEEP_S);
    return body;
  }).finally(() => { inflight = null; });
  return inflight;
}

module.exports = async function handler(req, res) {
  const key = process.env.TRAFIKVERKET_API_KEY;
  if (!key) return send(res, 200, JSON.stringify({ enabled: false, rows: [] }), 300);
  if (!mem.body) { const stored = await redis("GET", "se:cams"); if (stored) { try { mem = JSON.parse(stored); } catch {} } }
  if (mem.body) {
    if (Date.now() - mem.t > FRESH_MS) refresh(key).catch(() => {}); // stale: serve now, refresh in the background
    return send(res, 200, mem.body, 3600);
  }
  try { return send(res, 200, await refresh(key), 3600); }
  catch (e) { return send(res, 502, JSON.stringify({ enabled: true, error: String(e.message || e).slice(0, 160), rows: [] }), 0); }
};
