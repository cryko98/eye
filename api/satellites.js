/**
 * /api/satellites — Vercel serverless function.
 * CelesTrak asks clients not to fetch the same element set more than once every two hours
 * per IP, which a public web page cannot guarantee. This proxy fetches the TLE groups once,
 * keeps them for two hours in memory and at the edge, and serves every visitor from that.
 * Returns plain 3-line TLE text (stations group first, then the brightest objects).
 */
const GROUPS = ["stations", "visual"];
const TTL_MS = 2 * 3600_000;
let cache = { t: 0, body: null };
let inflight = null;

function send(res, body, state) {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=7200, stale-while-revalidate=86400, max-age=1800");
  res.setHeader("X-Feed-State", state);
  res.statusCode = 200;
  res.end(body);
}

module.exports = async function handler(req, res) {
  const now = Date.now();
  if (cache.body && now - cache.t < TTL_MS) return send(res, cache.body, "memory");
  try {
    inflight ||= (async () => {
      const parts = [];
      for (const g of GROUPS) {
        const r = await fetch(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${g}&FORMAT=tle`, { headers: { "User-Agent": "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)" } });
        if (!r.ok) throw new Error(`celestrak ${g} ${r.status}`);
        const txt = await r.text();
        if (!/^1 \d{5}/m.test(txt)) throw new Error(`celestrak ${g} not TLE`);
        parts.push(txt.trim());
      }
      const body = parts.join("\n") + "\n";
      cache = { t: Date.now(), body };
      return body;
    })().finally(() => { inflight = null; });
    return send(res, await inflight, "fresh");
  } catch (e) {
    if (cache.body) return send(res, cache.body, "stale");
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(`# ${String(e.message || e)}`);
  }
};
