/**
 * /api/windy — Vercel serverless function (optional).
 * Worldwide webcams from the Windy Webcams API v3 (tens of thousands of cameras on
 * every continent, including Africa, Asia and South America). Needs a free key:
 * https://api.windy.com/keys  →  set WINDY_API_KEY in Vercel environment variables.
 *
 *   GET /api/windy                 → { enabled: true|false }
 *   GET /api/windy?lat=..&lon=..   → { rows: [[id, title, lat, lon, previewUrl, place]] } within `radius` km (default 250)
 *
 * Row preview URLs are Windy's current still images. Attribution: "Webcams by Windy.com".
 */
const KEY = process.env.WINDY_API_KEY || "";
const cache = new Map();
const TTL_MS = 10 * 60_000;

function send(res, status, body, maxAge = 600) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", `public, s-maxage=${maxAge}, stale-while-revalidate=3600, max-age=60`);
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const lat = parseFloat(url.searchParams.get("lat")), lon = parseFloat(url.searchParams.get("lon"));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return send(res, 200, { enabled: Boolean(KEY) }, 300);
  if (!KEY) return send(res, 200, { enabled: false, rows: [] }, 300);
  const radius = Math.min(500, Math.max(10, parseInt(url.searchParams.get("radius") || "250", 10)));
  const key = `${lat.toFixed(1)},${lon.toFixed(1)},${radius}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return send(res, 200, hit.body);
  try {
    const api = `https://api.windy.com/webcams/api/v3/webcams?nearby=${lat.toFixed(3)},${lon.toFixed(3)},${radius}&limit=50&include=images,location&sortKey=popularity&sortDirection=desc`;
    const r = await fetch(api, { headers: { "x-windy-api-key": KEY, "User-Agent": "gods-eye-view-eye/1.0" } });
    if (!r.ok) throw new Error(`windy ${r.status}`);
    const j = await r.json();
    const rows = (j.webcams || []).filter((w) => w.status !== "inactive" && w.images?.current?.preview && w.location).map((w) => [
      String(w.webcamId ?? w.id), w.title || "Webcam", +w.location.latitude.toFixed(5), +w.location.longitude.toFixed(5),
      w.images.current.preview, [w.location.city, w.location.country].filter(Boolean).join(", "),
    ]);
    const body = { enabled: true, total: j.total ?? rows.length, rows };
    cache.set(key, { t: Date.now(), body });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return send(res, 200, body);
  } catch (e) {
    return send(res, 502, { enabled: true, error: String(e.message || e), rows: [] }, 0);
  }
};
