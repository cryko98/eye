/**
 * /api/flights — Vercel serverless function.
 *
 * Proxies live ADS-B state vectors from the OpenSky Network (the browser cannot
 * call it directly: no CORS) and compacts them for the globe. Responses are
 * cached in memory and at the Vercel edge so thousands of visitors share a
 * handful of upstream requests per minute.
 *
 * Optional env vars (Vercel → Settings → Environment Variables) for a higher
 * OpenSky quota: OPENSKY_CLIENT_ID, OPENSKY_CLIENT_SECRET (OAuth2 client
 * credentials from your OpenSky account). Anonymous access works without them.
 *
 * Row format: [icao24, callsign, lon, lat, alt_m, speed_ms, heading_deg, country, vrate_ms]
 */

const OPENSKY_URL = "https://opensky-network.org/api/states/all";
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const MAX_ROWS = 6000;
const TTL_MS = 45_000;

// Fallback: adsb.lol has no global endpoint, so sample busy regions (250 nm each).
const FALLBACK_HUBS = [
  [51.5, -0.1], [40.7, -74.0], [50.1, 8.7], [25.3, 55.4], [35.7, 139.7], [34.0, -118.2],
  [41.9, 12.5], [1.35, 103.8], [-23.5, -46.6], [19.1, 72.9], [33.7, -84.4], [48.9, 2.3],
];

let cache = { t: 0, body: null };
let inflight = null;
let token = { value: null, exp: 0 };

async function getToken() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token.value && Date.now() < token.exp) return token.value;
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  token = { value: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 1800) - 60) * 1000 };
  return token.value;
}

async function fromOpenSky() {
  const headers = { "User-Agent": "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)" };
  const t = await getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(OPENSKY_URL, { headers });
  if (!r.ok) throw new Error(`opensky ${r.status}`);
  const j = await r.json();
  const states = (j.states || []).filter((s) => s[5] != null && s[6] != null && !s[8]);
  states.sort((a, b) => ((b[1] || "").trim() ? 1 : 0) - ((a[1] || "").trim() ? 1 : 0));
  const rows = states.slice(0, MAX_ROWS).map((s) => [
    s[0], (s[1] || "").trim(), +s[5].toFixed(3), +s[6].toFixed(3),
    Math.round(s[13] ?? s[7] ?? 0), Math.round(s[9] ?? 0), Math.round(s[10] ?? 0), s[2] || "", Math.round(s[11] ?? 0),
  ]);
  return { time: j.time, total: (j.states || []).length, source: "opensky", rows };
}

async function fromAdsbLol() {
  const seen = new Map();
  await Promise.all(FALLBACK_HUBS.map(async ([lat, lon]) => {
    try {
      const r = await fetch(`https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`);
      if (!r.ok) return;
      const j = await r.json();
      for (const a of j.ac || []) {
        if (a.lat == null || a.lon == null || a.alt_baro === "ground") continue;
        const altFt = typeof a.alt_geom === "number" ? a.alt_geom : typeof a.alt_baro === "number" ? a.alt_baro : 0;
        seen.set(a.hex, [
          a.hex, (a.flight || "").trim(), +a.lon.toFixed(3), +a.lat.toFixed(3),
          Math.round(altFt * 0.3048), Math.round((a.gs || 0) * 0.5144), Math.round(a.track || a.true_heading || 0), "", Math.round((a.baro_rate || 0) * 0.00508),
        ]);
      }
    } catch {}
  }));
  const rows = [...seen.values()];
  if (!rows.length) throw new Error("adsb.lol empty");
  return { time: Math.floor(Date.now() / 1000), total: rows.length, source: "adsb.lol", rows };
}

function send(res, body, state) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=45, stale-while-revalidate=600, max-age=20");
  res.setHeader("X-Feed-State", state);
  res.statusCode = 200;
  res.end(body);
}

module.exports = async function handler(req, res) {
  const now = Date.now();
  if (cache.body && now - cache.t < TTL_MS) return send(res, cache.body, "memory");
  try {
    inflight ||= (async () => {
      let data;
      try { data = await fromOpenSky(); }
      catch (e) { data = await fromAdsbLol(); data.fallbackReason = String(e.message || e); }
      const body = JSON.stringify(data);
      cache = { t: Date.now(), body };
      return body;
    })().finally(() => { inflight = null; });
    return send(res, await inflight, "fresh");
  } catch (e) {
    if (cache.body) return send(res, cache.body, "stale");
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.end(JSON.stringify({ error: String(e.message || e), rows: [] }));
  }
};
