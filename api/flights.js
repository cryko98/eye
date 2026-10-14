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
const TTL_MS = 60_000;

// Fallback: adsb.lol has no global endpoint, so sample busy regions (250 nm each).
// Fallback sources only answer within 250 nm of a point, so we sample ~50 hubs that cover every busy region.
const FALLBACK_HUBS = [
  // Europe
  [51.5, -0.1], [48.9, 2.3], [50.1, 8.7], [40.4, -3.7], [41.9, 12.5], [52.2, 21.0], [59.3, 18.0], [41.0, 29.0], [38.0, 23.7], [55.75, 37.6], [53.3, -6.3], [47.5, 19.0], [60.2, 24.9], [43.3, -8.4],
  // North America
  [40.7, -74.0], [41.9, -87.6], [33.7, -84.4], [32.8, -96.8], [39.7, -104.9], [34.0, -118.2], [37.6, -122.4], [47.4, -122.3], [25.8, -80.2], [43.7, -79.4], [19.4, -99.1], [44.9, -93.2], [33.4, -112.0], [49.2, -123.1], [51.0, -114.0], [61.2, -149.9], [21.3, -157.9],
  // South America
  [-23.5, -46.6], [4.7, -74.1], [-33.4, -70.7], [-34.6, -58.4], [-12.0, -77.0],
  // Middle East, Asia
  [25.3, 55.4], [24.7, 46.7], [32.0, 34.8], [28.6, 77.2], [19.1, 72.9], [13.7, 100.5], [1.35, 103.8], [22.3, 114.2], [31.2, 121.5], [39.9, 116.4], [37.5, 127.0], [35.7, 139.7], [25.0, 121.5], [14.6, 121.0], [-6.2, 106.8],
  // Oceania
  [-33.9, 151.2], [-37.8, 145.0], [-27.4, 153.0], [-31.9, 115.9], [-36.8, 174.8],
  // Africa
  [-26.2, 28.0], [30.0, 31.2], [-1.3, 36.8], [6.5, 3.4], [33.6, -7.6], [9.0, 38.7],
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
  const r = await fetch(OPENSKY_URL, { headers, signal: AbortSignal.timeout(9000) });
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

const HUB_SOURCES = {
  "adsb.lol": (lat, lon) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`,
  "adsb.fi": (lat, lon) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/250`,
};
async function runBatches(items, size, fn) {
  for (let i = 0; i < items.length; i += size) await Promise.all(items.slice(i, i + size).map(fn));
}
async function fromHubs(name, concurrency = 12) {
  const seen = new Map(); const errors = [];
  await runBatches(FALLBACK_HUBS, concurrency, async ([lat, lon]) => {
    try {
      const r = await fetch(HUB_SOURCES[name](lat, lon), { headers: { "User-Agent": "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)" }, signal: AbortSignal.timeout(6000) });
      if (!r.ok) { errors.push(`${r.status}`); return; }
      const j = await r.json();
      for (const a of j.ac || j.aircraft || []) {
        if (a.lat == null || a.lon == null || a.alt_baro === "ground") continue;
        const altFt = typeof a.alt_geom === "number" ? a.alt_geom : typeof a.alt_baro === "number" ? a.alt_baro : 0;
        seen.set(a.hex, [
          a.hex, (a.flight || "").trim(), +a.lon.toFixed(3), +a.lat.toFixed(3),
          Math.round(altFt * 0.3048), Math.round((a.gs || 0) * 0.5144), Math.round(a.track || a.true_heading || 0), "", Math.round((a.baro_rate || 0) * 0.00508),
        ]);
      }
    } catch (e) { errors.push(String(e.message || e).slice(0, 40)); }
  });
  const rows = [...seen.values()];
  if (!rows.length) throw new Error(`${name} empty (${errors.slice(0, 3).join(", ") || "no data"})`);
  return { time: Math.floor(Date.now() / 1000), total: rows.length, source: name, rows };
}

function send(res, body, state) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600, max-age=20");
  res.setHeader("X-Feed-State", state);
  res.statusCode = 200;
  res.end(body);
}

let openskyDownUntil = 0;
async function loadAny() {
  const reasons = [];
  if (Date.now() < openskyDownUntil) reasons.push("opensky: skipped (recent failure)");
  else {
    try { return await fromOpenSky(); }
    catch (e) { reasons.push(`opensky: ${String(e.message || e).slice(0, 80)}`); openskyDownUntil = Date.now() + 10 * 60_000; }
  }
  // Both hub sources at once, merged by ICAO hex: adsb.fi answers fast, adsb.lol fills in what it can within the budget.
  const results = await Promise.allSettled([fromHubs("adsb.fi", 20), fromHubs("adsb.lol", 15)]);
  const merged = new Map(); const used = [];
  for (const r of results) {
    if (r.status !== "fulfilled") { reasons.push(String(r.reason?.message || r.reason).slice(0, 80)); continue; }
    used.push(`${r.value.source} ${r.value.rows.length}`);
    for (const row of r.value.rows) if (!merged.has(row[0])) merged.set(row[0], row);
  }
  if (!merged.size) throw new Error(reasons.join(" | "));
  const rows = [...merged.values()].slice(0, MAX_ROWS);
  return { time: Math.floor(Date.now() / 1000), total: rows.length, source: used.map((u) => u.split(" ")[0]).join("+"), sources: used, fallbackReason: reasons.join(" | ") || undefined, rows };
}

module.exports = async function handler(req, res) {
  const now = Date.now();
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("debug") === "1") {
    const out = {};
    for (const [name, fn] of [["opensky", fromOpenSky], ["adsb.lol", () => fromHubs("adsb.lol")], ["adsb.fi", () => fromHubs("adsb.fi")]]) {
      const t0 = Date.now();
      try { const d = await fn(); out[name] = { ok: true, rows: d.rows.length, ms: Date.now() - t0 }; }
      catch (e) { out[name] = { ok: false, error: String(e.message || e).slice(0, 160), ms: Date.now() - t0 }; }
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.statusCode = 200;
    return res.end(JSON.stringify({ cached: !!cache.body, cacheAge: cache.body ? Math.round((now - cache.t) / 1000) : null, sources: out }));
  }
  if (cache.body && now - cache.t < TTL_MS) return send(res, cache.body, "memory");
  try {
    inflight ||= (async () => {
      const data = await loadAny();
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
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: String(e.message || e), rows: [] }));
  }
};
