/**
 * /api/estonia — Vercel serverless function.
 * Estonian road cameras (Transpordiamet / Tarktee) publish time-stamped image
 * URLs that change every minute, so the static catalog only stores location ids.
 * This returns { locationId: latestImageUrl } from the DATEX II feed, cached 60 s.
 */
const FEED = "https://tarktee.transpordiamet.ee/api/v1/datex/roadCameraImages";
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
      if (!r.ok) throw new Error(`tarktee ${r.status}`);
      const xml = await r.text();
      const map = {};
      for (const m of xml.matchAll(/linearPredefinedLocationReference[^>]*\sid="([^"]+)"[\s\S]*?<urlLinkAddress>([^<]+)<\/urlLinkAddress>/g)) map[m[1]] = m[2];
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
