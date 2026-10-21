/**
 * /api/sweden — Vercel serverless function.
 * Swedish road and road-weather cameras from Trafikverket's open data API (free key:
 * https://api.trafikinfo.trafikverket.se → register → create an API key). Set it on Vercel
 * as TRAFIKVERKET_API_KEY. Without it this returns { enabled: false } and the site simply
 * shows no Swedish cameras.
 *
 * Returns { enabled, total, rows: [[id, name, lat, lon, photoUrl]] }, cached 6 hours.
 */
const API = "https://api.trafikinfo.trafikverket.se/v2/data.json";
const TTL_MS = 6 * 3600_000;
let cache = { t: 0, body: null };
let inflight = null;

function send(res, status, body, maxAge) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", `public, s-maxage=${maxAge}, stale-while-revalidate=86400, max-age=600`);
  res.end(body);
}

async function load(key) {
  const xml = `<REQUEST><LOGIN authenticationkey="${key}" />` +
    `<QUERY objecttype="Camera" schemaversion="1"><FILTER><EQ name="Active" value="true" /></FILTER>` +
    `<INCLUDE>Id</INCLUDE><INCLUDE>Name</INCLUDE><INCLUDE>PhotoUrl</INCLUDE><INCLUDE>Geometry.WGS84</INCLUDE></QUERY></REQUEST>`;
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "text/xml", "User-Agent": "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)" }, body: xml, signal: AbortSignal.timeout(20000) });
  const j = await r.json();
  const result = j?.RESPONSE?.RESULT?.[0] || {};
  if (result.ERROR) throw new Error(`trafikverket: ${result.ERROR.MESSAGE || "error"}`);
  const rows = [];
  for (const c of result.Camera || []) {
    const m = String(c?.Geometry?.WGS84 || "").match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/);
    if (!m || !c.PhotoUrl) continue;
    rows.push([String(c.Id), String(c.Name || "Kamera").slice(0, 60), +(+m[2]).toFixed(5), +(+m[1]).toFixed(5), c.PhotoUrl]);
  }
  return JSON.stringify({ enabled: true, total: rows.length, rows });
}

module.exports = async function handler(req, res) {
  const key = process.env.TRAFIKVERKET_API_KEY;
  if (!key) return send(res, 200, JSON.stringify({ enabled: false, rows: [] }), 300);
  if (cache.body && Date.now() - cache.t < TTL_MS) return send(res, 200, cache.body, 21600);
  try {
    inflight ||= load(key).then((body) => { cache = { t: Date.now(), body }; return body; }).finally(() => { inflight = null; });
    return send(res, 200, await inflight, 21600);
  } catch (e) {
    if (cache.body) return send(res, 200, cache.body, 600);
    return send(res, 502, JSON.stringify({ enabled: true, error: String(e.message || e).slice(0, 160), rows: [] }), 0);
  }
};
