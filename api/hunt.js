/**
 * /api/hunt — the Hidden Eyes treasure hunt (Vercel serverless function).
 *
 * The hunt runs in HOURLY ROUNDS. EGGS_JSON holds a POOL of eyes (kept only in the
 * environment, never in this repo); every round the server deterministically draws a
 * fresh set from the pool (3 easy, 6 hard, 1 brutal by default). Within a round the first
 * REWARD_WINNERS_PER_ROUND wallets that find ROUND_TARGET eyes are paid REWARD_SOL
 * automatically. Raise REWARD_SOL (or ROUND_TARGET) any time without redeploying code.
 *
 * Environment variables:
 *   EGGS_JSON                   JSON array: the pool of eyes (see README for the schema)
 *   HUNT_SECRET                 random string: signs tokens, sessions and the hourly draw
 *   ROUND_MINUTES               round length (default 60)
 *   ROUND_SIZE                  eyes per round (default 10)  ROUND_MIX "3,6,1" easy,hard,brutal
 *   ROUND_TARGET                eyes a wallet must find in a round to win (default 10 = all)
 *   REWARD_SOL                  SOL per winner (default 0.2)
 *   REWARD_WINNERS_PER_ROUND    winners paid per round (default 10)
 *   REWARD_SECRET_KEY           base58 secret key of the payout hot wallet (payouts off if unset)
 *   SOLANA_RPC_URL              optional RPC endpoint
 *   UPSTASH_REDIS_REST_URL/TOKEN  Upstash Redis (memory fallback without it)
 *
 * Actions:  GET  ?a=state[&wallet=]    GET ?a=near&lat&lon&h     GET ?a=hints[&wallet=]
 *           POST ?a=register {wallet, message, signature}
 *           POST ?a=probe {wallet, session, kind: ground|cam|sat|plane, ...payload}
 */
const crypto = require("crypto");

/* ---------------- storage ---------------- */
const KV_URL = process.env.UPSTASH_REDIS_REST_URL, KV_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const mem = { h: new Map(), kv: new Map(), exp: new Map() };
async function redis(...cmd) {
  if (!KV_URL) return memCmd(cmd);
  const r = await fetch(KV_URL, { method: "POST", headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
  const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
}
function memCmd([op, k, a, b]) {
  const now = Date.now(); for (const [key, t] of mem.exp) if (t < now) { mem.exp.delete(key); mem.kv.delete(key); mem.h.delete(key); }
  switch (op) {
    case "HGET": return mem.h.get(k)?.get(a) ?? null;
    case "HSET": { if (!mem.h.has(k)) mem.h.set(k, new Map()); mem.h.get(k).set(a, b); return 1; }
    case "HGETALL": { const out = []; for (const [f, v] of mem.h.get(k) || []) out.push(f, v); return out; }
    case "INCR": { const v = parseInt(mem.kv.get(k) || "0", 10) + 1; mem.kv.set(k, String(v)); return v; }
    case "EXPIRE": { mem.exp.set(k, now + a * 1000); return 1; }
    case "GET": return mem.kv.get(k) ?? null;
    case "SET": { mem.kv.set(k, a); return "OK"; }
    default: throw new Error("unsupported " + op);
  }
}

/* ---------------- config + rounds ---------------- */
const num = (k, d) => { const v = parseFloat(process.env[k]); return Number.isFinite(v) ? v : d; };
const CFG = () => ({
  roundMs: num("ROUND_MINUTES", 60) * 60_000, size: Math.round(num("ROUND_SIZE", 10)),
  mix: (process.env.ROUND_MIX || "3,6,1").split(",").map((x) => parseInt(x, 10) || 0),
  target: Math.round(num("ROUND_TARGET", 10)), rewardSol: num("REWARD_SOL", 0.2), winnersMax: Math.round(num("REWARD_WINNERS_PER_ROUND", 10)),
});
function pool() { try { const l = JSON.parse(process.env.EGGS_JSON || "[]"); return Array.isArray(l) ? l.filter((e) => e && e.id && e.type) : []; } catch { return []; } }
const SECRET = process.env.HUNT_SECRET || "";
const hmac = (s) => crypto.createHmac("sha256", SECRET || "unarmed").update(s).digest();
const sign = (s) => hmac(s).toString("hex").slice(0, 24);
function roundInfo(now = Date.now()) { const c = CFG(); const id = Math.floor(now / c.roundMs); return { id, startsAt: id * c.roundMs, endsAt: (id + 1) * c.roundMs, ...c }; }
function roundEggs(rid) {
  const all = pool(); const c = CFG(); if (!all.length) return [];
  const score = (e) => hmac(`draw:${rid}:${e.id}`).readUInt32BE(0);
  const sorted = [...all].sort((a, b) => score(a) - score(b));
  const want = { easy: c.mix[0] || 0, hard: c.mix[1] || 0, brutal: c.mix[2] || 0 };
  const chosen = [];
  for (const d of ["easy", "hard", "brutal"]) for (const e of sorted) { if (chosen.length >= c.size) break; if ((e.difficulty || "hard") === d && want[d] > 0 && !chosen.includes(e)) { chosen.push(e); want[d]--; } }
  for (const e of sorted) { if (chosen.length >= c.size) break; if (!chosen.includes(e)) chosen.push(e); }
  return chosen.slice(0, c.size);
}
const publicEgg = (e, idx) => ({ idx, id: e.id, title: e.title || `Eye ${idx + 1}`, text: e.text || "", difficulty: e.difficulty || "hard" });

/* ---------------- helpers ---------------- */
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
const bad = (res, code, msg) => send(res, code, { error: msg });
const haversine = (la1, lo1, la2, lo2) => { const R = 6371, p = Math.PI / 180, dLa = (la2 - la1) * p, dLo = (lo2 - lo1) * p; const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * p) * Math.cos(la2 * p) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(a)); };
const isWallet = (w) => typeof w === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w);
async function rateLimit(key, limit, windowSec) { const n = await redis("INCR", key); if (n === 1) await redis("EXPIRE", key, windowSec); return n <= limit; }
async function readBody(req) { if (req.body && typeof req.body === "object") return req.body; const chunks = []; for await (const c of req) chunks.push(c); try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; } }
const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "ip").toString().split(",")[0].trim();

/* ---------------- players ---------------- */
async function getPlayer(wallet) { const raw = await redis("HGET", "hunt:players", wallet); return raw ? JSON.parse(raw) : null; }
async function savePlayer(p) { await redis("HSET", "hunt:players", p.wallet, JSON.stringify(p)); }
async function getRoundPlayer(rid, wallet) { const raw = await redis("HGET", `hunt:round:${rid}`, wallet); return raw ? JSON.parse(raw) : { wallet, found: [], last: 0 }; }
async function saveRoundPlayer(rid, rp) { await redis("HSET", `hunt:round:${rid}`, rp.wallet, JSON.stringify(rp)); await redis("EXPIRE", `hunt:round:${rid}`, 7 * 86400); }
async function roundWinners(rid) { return parseInt((await redis("GET", `hunt:round:${rid}:winners`)) || "0", 10); }
async function hashRows(key) { const flat = (await redis("HGETALL", key)) || []; const rows = []; for (let i = 0; i < flat.length; i += 2) { try { rows.push(JSON.parse(flat[i + 1])); } catch {} } return rows; }
async function roundLeaderboard(rid) {
  const rows = (await hashRows(`hunt:round:${rid}`)).map((p) => ({ wallet: p.wallet, found: p.found.length, done: !!p.doneAt, paid: !!p.paidTx, last: p.doneAt || p.last }));
  rows.sort((a, b) => b.found - a.found || (a.last || 0) - (b.last || 0)); return rows;
}
async function allTime() {
  const rows = (await hashRows("hunt:players")).map((p) => ({ wallet: p.wallet, wins: p.wins || 0, sol: p.sol || 0, found: p.totalFound || 0 }));
  rows.sort((a, b) => b.wins - a.wins || b.sol - a.sol || b.found - a.found); return rows;
}

/* ---------------- payout ---------------- */
async function payout(rid, wallet, sol) {
  const secret = process.env.REWARD_SECRET_KEY; if (!secret) return { paid: false, reason: "payout wallet not configured" };
  try {
    const { Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL, sendAndConfirmTransaction } = require("@solana/web3.js");
    const bs58 = require("bs58"); const decode = bs58.decode || bs58.default?.decode;
    const payer = Keypair.fromSecretKey(decode(secret));
    const conn = new Connection(process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com", "confirmed");
    const lamports = Math.round(sol * LAMPORTS_PER_SOL);
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: new PublicKey(wallet), lamports }));
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: "confirmed" });
    return { paid: true, tx: sig, sol };
  } catch (e) { return { paid: false, reason: String(e.message || e).slice(0, 160) }; }
}

/* ---------------- matching ---------------- */
function matchEgg(e, rid, kind, body) {
  if (e.type !== kind) return false;
  if (kind === "ground") { const lat = +body.lat, lon = +body.lon; return body.token === sign(`g:${rid}:${e.id}`) && isFinite(lat) && isFinite(lon) && haversine(lat, lon, e.lat, e.lon) <= (e.radiusKm || 3); }
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
  const round = roundInfo(); const eggs = roundEggs(round.id); const armed = eggs.length > 0 && !!SECRET;
  const ip = ipOf(req);
  const roundPublic = async () => ({ id: round.id, startsAt: round.startsAt, endsAt: round.endsAt, now: Date.now(), total: eggs.length, target: Math.min(round.target, eggs.length || round.target), winnersMax: round.winnersMax, winners: await roundWinners(round.id), rewardSol: round.rewardSol, payoutEnabled: !!process.env.REWARD_SECRET_KEY });
  try {
    if (a === "state") {
      const wallet = url.searchParams.get("wallet"); const ok = wallet && isWallet(wallet);
      const [lb, all, rp, p] = await Promise.all([roundLeaderboard(round.id), allTime(), ok ? getRoundPlayer(round.id, wallet) : null, ok ? getPlayer(wallet) : null]);
      return send(res, 200, {
        armed, round: await roundPublic(), participants: (await hashRows("hunt:players")).length,
        leaderboard: lb.slice(0, 30), allTime: all.slice(0, 20),
        me: p ? { wallet, found: rp.found.map((id) => { const i = eggs.findIndex((e) => e.id === id); return i >= 0 ? publicEgg(eggs[i], i) : null; }).filter(Boolean), doneAt: rp.doneAt || null, paidTx: rp.paidTx || null, wins: p.wins || 0, sol: p.sol || 0 } : null,
      });
    }
    if (a === "hints") {
      const wallet = url.searchParams.get("wallet"); const rp = wallet && isWallet(wallet) ? await getRoundPlayer(round.id, wallet) : { found: [] };
      const hints = eggs.filter((e) => !rp.found.includes(e.id)).flatMap((e) => (e.hints || []).map((h) => ({ hint: h, difficulty: e.difficulty || "hard" })));
      return send(res, 200, { armed, round: round.id, hints });
    }
    if (a === "near") {
      if (!armed) return send(res, 200, { markers: [], round: round.id });
      if (!(await rateLimit(`hunt:rl:near:${ip}`, 40, 60))) return bad(res, 429, "slow down");
      const lat = +url.searchParams.get("lat"), lon = +url.searchParams.get("lon"), h = +url.searchParams.get("h");
      if (![lat, lon, h].every(Number.isFinite) || h > 80_000) return send(res, 200, { markers: [], round: round.id });
      const markers = eggs.map((e) => e.type === "ground" && haversine(lat, lon, e.lat, e.lon) <= (e.revealKm || 20) && h <= (e.revealBelowM || 60_000) ? { token: sign(`g:${round.id}:${e.id}`), lat: e.lat, lon: e.lon } : null).filter(Boolean);
      return send(res, 200, { markers, round: round.id });
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
        if (!nacl.sign.detached.verify(Buffer.from(message, "utf8"), Buffer.from(signature, "base64"), decode(wallet))) return bad(res, 401, "signature invalid");
      } catch { return bad(res, 401, "signature invalid"); }
      let p = await getPlayer(wallet);
      if (!p) { p = { wallet, joined: Date.now(), totalFound: 0, wins: 0, sol: 0 }; await savePlayer(p); }
      return send(res, 200, { ok: true, session: sign(`s:${wallet}`) });
    }
    if (a === "probe") {
      if (!armed) return send(res, 200, { found: false, armed: false });
      if (body.session !== sign(`s:${wallet}`)) return bad(res, 401, "connect your wallet first");
      if (!(await rateLimit(`hunt:rl:probe:${wallet}`, 40, 60))) return bad(res, 429, "slow down, operator");
      const p = await getPlayer(wallet); if (!p) return bad(res, 401, "not registered");
      const rp = await getRoundPlayer(round.id, wallet);
      const kind = body.kind;
      const idx = eggs.findIndex((e) => !rp.found.includes(e.id) && matchEgg(e, round.id, kind, body));
      if (idx < 0) {
        const already = eggs.findIndex((e) => rp.found.includes(e.id) && matchEgg(e, round.id, kind, body));
        return send(res, 200, { found: false, round: round.id, already: already >= 0 ? publicEgg(eggs[already], already) : null, count: rp.found.length, total: eggs.length, target: round.target });
      }
      const e = eggs[idx];
      rp.found.push(e.id); rp.last = Date.now(); p.totalFound = (p.totalFound || 0) + 1;
      let reward = null; const target = Math.min(round.target, eggs.length);
      if (rp.found.length >= target && !rp.doneAt) {
        rp.doneAt = Date.now();
        const winners = await roundWinners(round.id);
        if (winners >= round.winnersMax) reward = { paid: false, reason: `all ${round.winnersMax} reward slots of this round are taken` };
        else {
          const n = await redis("INCR", `hunt:round:${round.id}:winners`); await redis("EXPIRE", `hunt:round:${round.id}:winners`, 7 * 86400);
          if (n > round.winnersMax) reward = { paid: false, reason: `all ${round.winnersMax} reward slots of this round are taken` };
          else { rp.place = n; p.wins = (p.wins || 0) + 1; reward = await payout(round.id, wallet, round.rewardSol); if (reward.paid) { rp.paidTx = reward.tx; p.sol = +((p.sol || 0) + round.rewardSol).toFixed(4); } }
        }
      }
      await saveRoundPlayer(round.id, rp); await savePlayer(p);
      return send(res, 200, { found: true, round: round.id, egg: publicEgg(e, idx), count: rp.found.length, total: eggs.length, target, done: !!rp.doneAt, place: rp.place || null, reward, rewardSol: round.rewardSol });
    }
    return bad(res, 404, "unknown action");
  } catch (e) { return bad(res, 500, String(e.message || e).slice(0, 200)); }
};
