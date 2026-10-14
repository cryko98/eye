/**
 * /api/hunt — the Hidden Eyes treasure hunt (Vercel serverless function).
 *
 * Ten "eyes" are hidden on the globe, on cameras, satellites and aircraft. Their
 * definitions live ONLY in the EGGS_JSON environment variable, never in this repo,
 * so nothing in the client or the source reveals them. The client only ever learns
 * about an eye when the server confirms a click.
 *
 * Environment variables (Vercel → Settings → Environment Variables):
 *   EGGS_JSON                 JSON array of eyes (see README for the schema)
 *   HUNT_SECRET               random string used to sign ground-eye tokens
 *   UPSTASH_REDIS_REST_URL    + UPSTASH_REDIS_REST_TOKEN   (free Upstash Redis; without it
 *                             the state lives in memory and resets on cold starts)
 *   REWARD_SECRET_KEY         base58 secret key of the payout wallet (hot wallet with SOL)
 *   REWARD_SOL                SOL paid to each wallet that finds all eyes (default 0.1)
 *   REWARD_MAX_WINNERS        how many wallets can be paid (default 10)
 *   SOLANA_RPC_URL            optional RPC endpoint (default public mainnet-beta)
 *
 * Actions:  GET  ?a=state[&wallet=]        GET ?a=near&lat&lon&h       GET ?a=hints
 *           POST ?a=register {wallet, message, signature}
 *           POST ?a=probe    {wallet, kind: ground|cam|sat|plane, ...payload}
 */
const crypto = require("crypto");

/* ---------------- storage: Upstash Redis REST, memory fallback ---------------- */
const KV_URL = process.env.UPSTASH_REDIS_REST_URL, KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = { h: new Map(), kv: new Map(), exp: new Map() };
async function redis(...cmd) {
  if (!KV_URL) return memCmd(cmd);
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
function memCmd([op, k, a, b]) {
  const now = Date.now(); for (const [key, t] of mem.exp) if (t < now) { mem.exp.delete(key); mem.kv.delete(key); }
  switch (op) {
    case "HGET": return mem.h.get(k)?.get(a) ?? null;
    case "HSET": { if (!mem.h.has(k)) mem.h.set(k, new Map()); mem.h.get(k).set(a, b); return 1; }
    case "HGETALL": { const out = []; for (const [f, v] of mem.h.get(k) || []) out.push(f, v); return out; }
    case "HLEN": return mem.h.get(k)?.size || 0;
    case "INCR": { const v = (parseInt(mem.kv.get(k) || "0", 10) + 1); mem.kv.set(k, String(v)); return v; }
    case "EXPIRE": { mem.exp.set(k, now + a * 1000); return 1; }
    case "GET": return mem.kv.get(k) ?? null;
    case "SET": { mem.kv.set(k, a); return "OK"; }
    default: throw new Error("unsupported " + op);
  }
}

/* ---------------- config ---------------- */
function eggs() {
  try { const list = JSON.parse(process.env.EGGS_JSON || "[]"); return Array.isArray(list) ? list : []; } catch { return []; }
}
const SECRET = process.env.HUNT_SECRET || "";
const sign = (s) => crypto.createHmac("sha256", SECRET || "unarmed").update(s).digest("hex").slice(0, 24);
const bad = (res, code, msg) => send(res, code, { error: msg });
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
const haversine = (la1, lo1, la2, lo2) => { const R = 6371, p = Math.PI / 180, dLa = (la2 - la1) * p, dLo = (lo2 - lo1) * p; const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
const isWallet = (w) => typeof w === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
async function rateLimit(key, limit, windowSec) { const n = await redis("INCR", key); if (n === 1) await redis("EXPIRE", key, windowSec); return n <= limit; }
async function readBody(req) { if (req.body && typeof req.body === "object") return req.body; const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; } }
const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "ip").toString().split(",")[0].trim();
const publicEgg = (e, idx) => ({ idx, title: e.title || `Eye ${idx + 1}`, text: e.text || "", difficulty: e.difficulty || "hard" });

/* ---------------- participants ---------------- */
async function getPlayer(wallet) { const raw = await redis("HGET", "hunt:players", wallet); return raw ? JSON.parse(raw) : null; }
async function savePlayer(p) { await redis("HSET", "hunt:players", p.wallet, JSON.stringify(p)); }
async function leaderboard() {
  const flat = await redis("HGETALL", "hunt:players") || [];
  const rows = []; for (let i = 0; i < flat.length; i += 2) { try { const p = JSON.parse(flat[i + 1]); rows.push({ wallet: p.wallet, found: p.found.length, last: p.last || p.joined, finished: !!p.finishedAt, paid: !!p.paidTx }); } catch {} }
  rows.sort((a, b) => b.found - a.found || (a.finishedAt || a.last || 0) - (b.finishedAt || b.last || 0));
  return rows;
}

/* ---------------- payout ---------------- */
async function payout(player) {
  const secret = process.env.REWARD_SECRET_KEY; if (!secret) return { paid: false, reason: "payout not configured" };
  const max = parseInt(process.env.REWARD_MAX_WINNERS || "10", 10);
  const winners = parseInt((await redis("GET", "hunt:winners")) || "0", 10);
  if (winners >= max) return { paid: false, reason: "prize pool exhausted" };
  try {
    const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require("@solana/web3.js");
    const bs58 = require("bs58"); const decode = bs58.decode || bs58.default?.decode;
    const payer = Keypair.fromSecretKey(decode(secret));
    const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
    const lamports = Math.round(parseFloat(process.env.REWARD_SOL || "0.1") * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(player.wallet), lamports }));
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    await redis("INCR", "hunt:winners");
    return { paid: true, tx: sig, sol: lamports / LAMPORTS_PER_SOL };
  } catch (e) { return { paid: false, reason: String(e.message || e).slice(0, 160) }; }
}

/* ---------------- matching ---------------- */
function matchEgg(e, kind, body) {
  if (e.type !== kind) return false;
  if (kind === "ground") { const lat = +body.lat, lon = +body.lon; return body.token === sign(`g:${e.id}`) && isFinite(lat) && isFinite(lon) && haversine(lat, lon, e.lat, e.lon) <= (e.radiusKm || 3); }
  if (kind === "cam") return typeof body.camId === "string" && e.camIds?.includes(body.camId);
  if (kind === "sat") return String(body.norad) === String(e.norad);
  if (kind === "plane") {
    const r = e.rule || {}; const cs = String(body.cs || "").toUpperCase(), alt = +body.alt, lat = +body.lat, lon = +body.lon, country = String(body.country || "");
    if (r.icao24 && String(body.icao || "").toLowerCase() !== String(r.icao24).toLowerCase()) return false;
    if (r.callsignPrefix && !cs.startsWith(String(r.callsignPrefix).toUpperCase())) return false;
    if (r.country && country.toLowerCase() !== String(r.country).toLowerCase()) return false;
    if (r.minAlt != null && !(alt >= r.minAlt)) return false;
    if (r.maxAlt != null && !(alt <= r.maxAlt)) return false;
    if (r.bbox && !(lon >= r.bbox[0] && lat >= r.bbox[1] && lon <= r.bbox[2] && lat <= r.bbox[3])) return false;
    return true;
  }
  return false;
}

/* ---------------- handler ---------------- */
module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  const url = new URL(req.url, "http://localhost");
  const a = url.searchParams.get("a") || "state";
  const list = eggs(); const armed = list.length > 0 && !!SECRET;
  const ip = ipOf(req);
  try {
    if (a === "state") {
      const wallet = url.searchParams.get("wallet");
      const lb = await leaderboard();
      const me = wallet && isWallet(wallet) ? await getPlayer(wallet) : null;
      return send(res, 200, {
        armed, total: list.length, participants: lb.length, finishers: lb.filter((r) => r.finished).length,
        payout: { enabled: !!process.env.REWARD_SECRET_KEY, sol: parseFloat(process.env.REWARD_SOL || "0.1"), maxWinners: parseInt(process.env.REWARD_MAX_WINNERS || "10", 10), paid: parseInt((await redis("GET", "hunt:winners")) || "0", 10) },
        leaderboard: lb.slice(0, 50),
        me: me ? { wallet: me.wallet, found: me.found.map((id) => { const i = list.findIndex((e) => e.id === id); return i >= 0 ? publicEgg(list[i], i) : null; }).filter(Boolean), finishedAt: me.finishedAt || null, paidTx: me.paidTx || null } : null,
      });
    }
    if (a === "hints") {
      const wallet = url.searchParams.get("wallet"); const me = wallet && isWallet(wallet) ? await getPlayer(wallet) : null;
      const pool = list.filter((e) => !me || !me.found.includes(e.id)).flatMap((e, i) => (e.hints || []).map((h) => ({ hint: h, difficulty: e.difficulty || "hard" })));
      return send(res, 200, { armed, hints: pool });
    }
    if (a === "near") {
      if (!armed) return send(res, 200, { markers: [] });
      if (!(await rateLimit(`hunt:rl:near:${ip}`, 40, 60))) return bad(res, 429, "slow down");
      const lat = +url.searchParams.get("lat"), lon = +url.searchParams.get("lon"), h = +url.searchParams.get("h");
      if (![lat, lon, h].every(Number.isFinite) || h > 80_000) return send(res, 200, { markers: [] });
      const markers = list.map((e) => e.type === "ground" && haversine(lat, lon, e.lat, e.lon) <= (e.revealKm || 20) && h <= (e.revealBelowM || 60_000) ? { token: sign(`g:${e.id}`), lat: e.lat, lon: e.lon } : null).filter(Boolean);
      return send(res, 200, { markers });
    }
    if (req.method !== "POST") return bad(res, 405, "method");
    const body = await readBody(req);
    const wallet = body.wallet; if (!isWallet(wallet)) return bad(res, 400, "wallet required");
    if (a === "register") {
      if (!(await rateLimit(`hunt:rl:reg:${ip}`, 10, 60))) return bad(res, 429, "slow down");
      const { message, signature } = body;
      if (typeof message !== "string" || !message.includes(wallet) || !/God's Eye View/.test(message)) return bad(res, 400, "bad message");
      try {
        const nacl = require("tweetnacl"); const bs58 = require("bs58"); const decode = bs58.decode || bs58.default?.decode;
        const ok = nacl.sign.detached.verify(Buffer.from(message, "utf8"), Buffer.from(signature, "base64"), decode(wallet));
        if (!ok) return bad(res, 401, "signature invalid");
      } catch { return bad(res, 401, "signature invalid"); }
      let p = await getPlayer(wallet);
      if (!p) { p = { wallet, joined: Date.now(), found: [], last: Date.now() }; await savePlayer(p); }
      return send(res, 200, { ok: true, session: sign(`s:${wallet}`), found: p.found.length });
    }
    if (a === "probe") {
      if (!armed) return send(res, 200, { found: false, armed: false });
      if (body.session !== sign(`s:${wallet}`)) return bad(res, 401, "connect your wallet first");
      if (!(await rateLimit(`hunt:rl:probe:${wallet}`, 40, 60))) return bad(res, 429, "slow down, operator");
      const p = await getPlayer(wallet); if (!p) return bad(res, 401, "not registered");
      const kind = body.kind;
      const idx = list.findIndex((e) => !p.found.includes(e.id) && matchEgg(e, kind, body));
      if (idx < 0) {
        const already = list.findIndex((e) => p.found.includes(e.id) && matchEgg(e, kind, body));
        return send(res, 200, { found: false, already: already >= 0 ? publicEgg(list[already], already) : null, count: p.found.length, total: list.length });
      }
      const e = list[idx];
      p.found.push(e.id); p.last = Date.now();
      let reward = null;
      if (p.found.length >= list.length && !p.finishedAt) { p.finishedAt = Date.now(); await savePlayer(p); reward = await payout(p); if (reward.paid) { p.paidTx = reward.tx; p.paidSol = reward.sol; } }
      await savePlayer(p);
      return send(res, 200, { found: true, egg: publicEgg(e, idx), count: p.found.length, total: list.length, finished: !!p.finishedAt, reward });
    }
    return bad(res, 404, "unknown action");
  } catch (e) { return bad(res, 500, String(e.message || e).slice(0, 200)); }
};
