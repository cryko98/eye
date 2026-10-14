/**
 * /api/flights — Vercel serverless function.
 *
 * Live ADS-B aircraft for the globe. Order of preference:
 *   1. OpenSky Network global state vectors (needs OPENSKY_CLIENT_ID/SECRET for a real
 *      quota; often unreachable from cloud IPs, so it is skipped for 10 min after a failure)
 *   2. adsb.fi (fallback adsb.lol) sampled around ~60 hubs worldwide. Those APIs allow about
 *      one request per second, so every invocation refreshes only a slice of the hubs and the
 *      per-hub results are kept in Redis (Upstash / Vercel KV) for a few minutes. Merged, the
 *      slices give worldwide coverage; each row carries its own fix time so the client
 *      dead-reckons from the real timestamp.
 *
 * Row: [icao24, callsign, lon, lat, alt_m, speed_ms, heading_deg, country, vrate_ms, fix_unix_s]
 */
const OPENSKY_URL = "https://opensky-network.org/api/states/all";
const TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token";
const MAX_ROWS = 8000;
const TTL_MS = 60_000;
const HUB_STALE_MS = 4 * 60_000;       // refresh a hub after this age
const HUB_KEEP_S = 12 * 60;            // Redis TTL per hub
const HUBS_PER_RUN = 14;               // paced at ~1 req/s → ~14 s per invocation
const UA = "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)";

// ~60 hubs (250 nm radius each) covering every busy region; order interleaves regions.
const HUBS = [
  [51.5, -0.1], [40.7, -74.0], [35.7, 139.7], [-33.9, 151.2], [25.3, 55.4], [-23.5, -46.6], [30.0, 31.2],
  [48.9, 2.3], [41.9, -87.6], [22.3, 114.2], [-37.8, 145.0], [28.6, 77.2], [4.7, -74.1], [-26.2, 28.0],
  [50.1, 8.7], [33.7, -84.4], [31.2, 121.5], [-27.4, 153.0], [1.35, 103.8], [-33.4, -70.7], [-1.3, 36.8],
  [40.4, -3.7], [32.8, -96.8], [39.9, 116.4], [-31.9, 115.9], [13.7, 100.5], [-34.6, -58.4], [6.5, 3.4],
  [41.9, 12.5], [39.7, -104.9], [37.5, 127.0], [-36.8, 174.8], [19.1, 72.9], [-12.0, -77.0], [33.6, -7.6],
  [52.2, 21.0], [34.0, -118.2], [25.0, 121.5], [24.7, 46.7], [-6.2, 106.8], [19.4, -99.1], [9.0, 38.7],
  [59.3, 18.0], [37.6, -122.4], [14.6, 121.0], [32.0, 34.8], [43.7, -79.4], [47.4, -122.3], [55.75, 37.6],
  [41.0, 29.0], [25.8, -80.2], [44.9, -93.2], [33.4, -112.0], [49.2, -123.1], [51.0, -114.0], [38.0, 23.7],
  [53.3, -6.3], [47.5, 19.0], [60.2, 24.9], [61.2, -149.9], [21.3, -157.9], [43.3, -8.4],
];
const HUB_SOURCES = {
  "adsb.fi": (lat, lon) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/250`,
  "adsb.lol": (lat, lon) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`,
};

/* ---------------- storage: Upstash / Vercel KV REST, memory fallback ---------------- */
const KV_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL, KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const memKv = new Map();
async function redis(...cmd) {
  if (!KV_URL) {
    const [op, k, ...rest] = cmd;
    if (op === "GET") { const e = memKv.get(k); return e && e.exp > Date.now() ? e.v : null; }
    if (op === "SET") { memKv.set(k, { v: rest[0], exp: Date.now() + (rest[2] || 600) * 1000 }); return "OK"; }
    if (op === "MGET") return k.map((key) => { const e = memKv.get(key); return e && e.exp > Date.now() ? e.v : null; });
    return null;
  }
  const body = cmd[0] === "MGET" ? ["MGET", ...cmd[1]] : cmd;
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}

/* ---------------- OpenSky ---------------- */
let token = { value: null, exp: 0 };
async function getToken() {
  const id = process.env.OPENSKY_CLIENT_ID, secret = process.env.OPENSKY_CLIENT_SECRET;
  if (!id || !secret) return null;
  if (token.value && Date.now() < token.exp) return token.value;
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }) });
  if (!r.ok) return null;
  const j = await r.json();
  token = { value: j.access_token, exp: Date.now() + Math.max(60, (j.expires_in || 1800) - 60) * 1000 };
  return token.value;
}
async function fromOpenSky() {
  const headers = { "User-Agent": UA };
  const t = await getToken(); if (t) headers.Authorization = `Bearer ${t}`;
  const r = await fetch(OPENSKY_URL, { headers, signal: AbortSignal.timeout(9000) });
  if (!r.ok) throw new Error(`opensky ${r.status}`);
  const j = await r.json();
  const fix = j.time || Math.floor(Date.now() / 1000);
  const states = (j.states || []).filter((s) => s[5] != null && s[6] != null && !s[8]);
  states.sort((a, b) => ((b[1] || "").trim() ? 1 : 0) - ((a[1] || "").trim() ? 1 : 0));
  const rows = states.slice(0, MAX_ROWS).map((s) => [s[0], (s[1] || "").trim(), +s[5].toFixed(3), +s[6].toFixed(3), Math.round(s[13] ?? s[7] ?? 0), Math.round(s[9] ?? 0), Math.round(s[10] ?? 0), s[2] || "", Math.round(s[11] ?? 0), fix]);
  return { time: fix, total: (j.states || []).length, source: "opensky", rows };
}

/* ---------------- hub sampling (paced, cached per hub) ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchHub(name, [lat, lon]) {
  const r = await fetch(HUB_SOURCES[name](lat, lon), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`${name} ${r.status}`);
  const j = await r.json(); const fix = Math.floor(Date.now() / 1000); const rows = [];
  for (const a of j.ac || j.aircraft || []) {
    if (a.lat == null || a.lon == null || a.alt_baro === "ground") continue;
    const altFt = typeof a.alt_geom === "number" ? a.alt_geom : typeof a.alt_baro === "number" ? a.alt_baro : 0;
    rows.push([a.hex, (a.flight || "").trim(), +a.lon.toFixed(3), +a.lat.toFixed(3), Math.round(altFt * 0.3048), Math.round((a.gs || 0) * 0.5144), Math.round(a.track || a.true_heading || 0), "", Math.round((a.baro_rate || 0) * 0.00508), fix]);
  }
  return rows;
}
async function fromHubs(stats) {
  const keys = HUBS.map((_, i) => `fl:hub:${i}`);
  const cached = (await redis("MGET", keys)) || [];
  const entries = cached.map((v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } });
  const now = Date.now();
  const order = HUBS.map((_, i) => i).sort((a, b) => (entries[a]?.t || 0) - (entries[b]?.t || 0));
  const todo = order.filter((i) => !entries[i] || now - entries[i].t > HUB_STALE_MS).slice(0, HUBS_PER_RUN);
  let refreshed = 0; const errors = [];
  for (const i of todo) {
    const started = Date.now();
    try { entries[i] = { t: Date.now(), rows: await fetchHub("adsb.fi", HUBS[i]) }; }
    catch (e1) {
      try { entries[i] = { t: Date.now(), rows: await fetchHub("adsb.lol", HUBS[i]) }; }
      catch (e2) { errors.push(`${i}: ${String(e1.message || e1).slice(0, 30)} / ${String(e2.message || e2).slice(0, 30)}`); continue; }
    }
    refreshed++;
    await redis("SET", `fl:hub:${i}`, JSON.stringify(entries[i]), "EX", HUB_KEEP_S);
    const wait = 1000 - (Date.now() - started); if (wait > 0) await sleep(wait);
  }
  const merged = new Map();
  for (const e of entries) if (e) for (const row of e.rows) { const prev = merged.get(row[0]); if (!prev || prev[9] < row[9]) merged.set(row[0], row); }
  const rows = [...merged.values()].slice(0, MAX_ROWS);
  const ages = entries.map((e) => (e ? Math.round((now - e.t) / 1000) : null));
  const covered = ages.filter((a) => a != null).length;
  if (stats) Object.assign(stats, { refreshed, covered, hubs: HUBS.length, errors: errors.slice(0, 5), oldestAgeS: Math.max(0, ...ages.filter((a) => a != null)) });
  if (!rows.length) throw new Error(`hubs empty (${errors.slice(0, 3).join(", ") || "no data"})`);
  return { time: Math.floor(now / 1000), total: rows.length, source: "adsb.fi", coverage: `${covered}/${HUBS.length} hubs`, rows };
}

/* ---------------- handler ---------------- */
let cache = { t: 0, body: null };
let inflight = null;
let openskyDownUntil = 0;
async function loadAny(stats = {}) {
  const reasons = [];
  if (Date.now() < openskyDownUntil) reasons.push("opensky: skipped (recent failure)");
  else {
    try { return await fromOpenSky(); }
    catch (e) { reasons.push(`opensky: ${String(e.message || e).slice(0, 80)}`); openskyDownUntil = Date.now() + 10 * 60_000; }
  }
  const data = await fromHubs(stats);
  data.fallbackReason = reasons.join(" | ") || undefined;
  return data;
}
function send(res, body, state) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=600, max-age=20");
  res.setHeader("X-Feed-State", state);
  res.statusCode = 200;
  res.end(body);
}
module.exports = async function handler(req, res) {
  const now = Date.now();
  const url = new URL(req.url, "http://localhost");
  if (url.searchParams.get("debug") === "1") {
    const out = { cached: !!cache.body, cacheAge: cache.body ? Math.round((now - cache.t) / 1000) : null, redis: !!KV_URL };
    const t0 = Date.now();
    try { const d = await fromOpenSky(); out.opensky = { ok: true, rows: d.rows.length, ms: Date.now() - t0 }; } catch (e) { out.opensky = { ok: false, error: String(e.message || e).slice(0, 120), ms: Date.now() - t0 }; }
    const stats = {}; const t1 = Date.now();
    try { const d = await fromHubs(stats); out.hubs = { ok: true, rows: d.rows.length, ms: Date.now() - t1, ...stats }; } catch (e) { out.hubs = { ok: false, error: String(e.message || e).slice(0, 120), ms: Date.now() - t1, ...stats }; }
    res.setHeader("Content-Type", "application/json; charset=utf-8"); res.setHeader("Cache-Control", "no-store"); res.statusCode = 200;
    return res.end(JSON.stringify(out));
  }
  if (cache.body && now - cache.t < TTL_MS) return send(res, cache.body, "memory");
  try {
    inflight ||= (async () => { const body = JSON.stringify(await loadAny()); cache = { t: Date.now(), body }; return body; })().finally(() => { inflight = null; });
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
