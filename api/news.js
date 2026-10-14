/**
 * /api/news?q=<place> — Vercel serverless function.
 * Regional headlines for the cockpit briefing strip. GDELT DOC 2.0 first (open data),
 * Google News RSS as a fail-soft fallback. Cached 10 minutes per query.
 * Returns { source, items: [{ title, url, source, time }] }
 */
const cache = new Map();
const TTL_MS = 10 * 60_000;
const UA = "gods-eye-view-eye/1.0 (+https://github.com/cryko98/eye)";

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600, max-age=120");
  res.end(JSON.stringify(body));
}
const clean = (s) => String(s || "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

async function fromGdelt(q) {
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${q}" sourcelang:english`)}&mode=artlist&maxrecords=8&format=json&timespan=3d&sort=datedesc`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`gdelt ${r.status}`);
  const j = await r.json();
  const items = (j.articles || []).map((a) => ({ title: a.title, url: a.url, source: a.domain, time: a.seendate })).filter((a) => a.title && a.url);
  if (!items.length) throw new Error("gdelt empty");
  return { source: "GDELT Project", items: items.slice(0, 6) };
}
async function fromGoogleNews(q) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`google news ${r.status}`);
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1], g = (t) => (b.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`)) || [])[1];
    const title = clean(g("title")), link = clean(g("link")), src = clean((b.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1]), time = clean(g("pubDate"));
    if (title && link) items.push({ title, url: link, source: src, time });
    if (items.length >= 6) break;
  }
  if (!items.length) throw new Error("google news empty");
  return { source: "Google News RSS", items };
}

module.exports = async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  if (!q) return send(res, 400, { error: "q required", items: [] });
  const key = q.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.t < TTL_MS) return send(res, 200, hit.body);
  let body;
  try { body = await fromGdelt(q); }
  catch { try { body = await fromGoogleNews(q); } catch (e) { body = { source: "none", items: [], error: String(e.message || e) }; } }
  cache.set(key, { t: Date.now(), body });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return send(res, 200, body);
};
