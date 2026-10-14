/**
 * /api/singapore — Vercel serverless function.
 * LTA traffic cameras via data.gov.sg (keyless). Image URLs are short-lived, so the
 * catalog stores camera ids and this returns { cameraId: latestImageUrl }, cached 60 s.
 */
const FEED = "https://api.data.gov.sg/v1/transport/traffic-images";
let cache = { t: 0, body: null };
let inflight = null;

function send(res, body, state) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600, max-age=30");
  res.setHeader("X-Feed-State", state);
  res.statusCode = 200;
  res.end(body);
}

module.exports = async function handler(req, res) {
  const now = Date.now();
  if (cache.body && now - cache.t < 60_000) return send(res, cache.body, "memory");
  try {
    inflight ||= (async () => {
      const r = await fetch(FEED, { headers: { "User-Agent": "gods-eye-view-eye/1.0" } });
      if (!r.ok) throw new Error(`data.gov.sg ${r.status}`);
      const j = await r.json();
      const map = {};
      for (const c of j.items?.[0]?.cameras || []) map[c.camera_id] = c.image;
      const body = JSON.stringify(map);
      cache = { t: Date.now(), body };
      return body;
    })().finally(() => { inflight = null; });
    return send(res, await inflight, "fresh");
  } catch (e) {
    if (cache.body) return send(res, cache.body, "stale");
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: String(e.message || e) }));
  }
};
