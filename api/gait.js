/* /api/gait/ : the shared robot dog on the Robot training page.

   GET  returns the shared state: the top gaits, totals across all visitors and a short
        history of the best score.
   POST takes one visitor's report: { id, tried, gen, ms, g? }. id is a random anonymous id
        the page keeps in localStorage. tried, gen and ms are how many gaits, generations and
        milliseconds of training ran since that browser's last report. g is optional: its best
        gait, sent when it could make the shared top five. The server scores g itself with the
        same sim the page runs (js/gaitsim.js); the score a browser claims is never used.

   State lives in Upstash Redis (Vercel Marketplace), reached over its REST API with fetch,
   so this needs no npm packages. Without the store's environment variables it answers 503,
   and the page trains on its own the way it did before sharing.

   Nothing personal is stored. The rate limit keys on a salted hash of the IP address that
   expires after two minutes. */
import { createHash } from 'node:crypto';
import { evaluate, validGenome, ELITE, SIM_VERSION } from '../js/gaitsim.js';

const P = `gait:${SIM_VERSION}:`;
const K = { elites: P + 'elites', gen: P + 'gen', tried: P + 'tried', ms: P + 'ms', visitors: P + 'visitors', hist: P + 'hist' };

export const LIMITS = {
  posts: 12, windowMs: 60_000,        // reports per IP per minute
  body: 4096,                          // bytes
  tried: 5000, gen: 400, ms: 600_000,  // the most one report can add (a tab manages about 14 gaits a second)
  hist: 40                             // best-score history entries kept
};

const NO_STORE = { 'Cache-Control': 'no-store' };
const CACHED = { 'Cache-Control': 'public, max-age=0, s-maxage=10, stale-while-revalidate=50' };

/* ---------- Upstash REST client: a pipeline, or a pipeline run as one transaction ---------- */
export function upstash(url, token, fetchImpl = fetch) {
  const base = url.replace(/\/+$/, '');
  async function call(path, cmds) {
    const res = await fetchImpl(base + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error(`store answered ${res.status}`);
    const out = await res.json();
    if (!Array.isArray(out)) throw new Error(out && out.error ? out.error : 'unexpected store reply');
    return out.map(r => { if (r && r.error) throw new Error(r.error); return r ? r.result : null; });
  }
  return { pipeline: cmds => call('/pipeline', cmds), multi: cmds => call('/multi-exec', cmds) };
}

// The Upstash integration names its variables KV_REST_API_*; Upstash's own docs use UPSTASH_REDIS_REST_*.
export function storeFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { redis: upstash(url, token), salt: env.GAIT_SALT || token };
}

/* ---------- reading state ---------- */
const STATE_READS = [
  ['ZREVRANGE', K.elites, 0, ELITE - 1, 'WITHSCORES'],
  ['MGET', K.gen, K.tried, K.ms],
  ['SCARD', K.visitors],
  ['LRANGE', K.hist, 0, -1]
];
const count = v => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

function elitesFrom(z) {
  const out = [];
  for (let i = 0; i + 1 < (z || []).length; i += 2) {
    let g = null;
    try { g = JSON.parse(z[i]); } catch (_) {}
    const f = Number(z[i + 1]);
    if (validGenome(g) && Number.isFinite(f)) out.push({ g, f });
  }
  return out;
}

function readState([z, m, v, h]) {
  const hist = [];
  for (const s of h || []) { try { const e = JSON.parse(s); if (Number.isFinite(e.f)) hist.push({ f: e.f, at: e.at }); } catch (_) {} }
  m = m || [];
  return { sim: SIM_VERSION, elites: elitesFrom(z), gen: count(m[0]), tried: count(m[1]), ms: count(m[2]), visitors: count(v), hist };
}

/* ---------- requests ---------- */
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
const bad = (error, status = 400) => json({ error }, status, NO_STORE);

function clientIp(request) {
  const h = request.headers;
  return (h.get('x-real-ip') || (h.get('x-forwarded-for') || '').split(',')[0] || 'unknown').trim();
}

async function report(request, store, now) {
  if (Number(request.headers.get('content-length')) > LIMITS.body) return bad('body too large', 413);
  const text = await request.text();
  if (text.length > LIMITS.body) return bad('body too large', 413);
  let body;
  try { body = JSON.parse(text); } catch (_) { return bad('body is not JSON'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be an object');

  const id = body.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return bad('id must be 8 to 64 letters, digits, - or _');
  const n = {};
  for (const k of ['tried', 'gen', 'ms']) {
    const v = body[k] == null ? 0 : body[k];
    if (!Number.isSafeInteger(v) || v < 0) return bad(`${k} must be a whole number of zero or more`);
    n[k] = Math.min(v, LIMITS[k]);
  }
  let g = null;
  if (body.g != null) {
    if (!validGenome(body.g)) return bad('g must be a gait: 27 numbers, each in its range');
    g = body.g.map(v => v + 0);   // turns -0 into 0, so the stored text and the scored numbers agree
  }

  // rate limit, and the current top five to compare against
  const win = Math.floor(now / LIMITS.windowMs);
  const who = createHash('sha256').update(`${store.salt}|${clientIp(request)}`).digest('hex').slice(0, 24);
  const rl = `${P}rl:${who}:${win}`;
  const [hits, , top] = await store.redis.pipeline([['INCR', rl], ['EXPIRE', rl, 120], STATE_READS[0]]);
  if (Number(hits) > LIMITS.posts) {
    return json({ error: 'too many reports, try again in a minute' }, 429, { ...NO_STORE, 'Retry-After': String(Math.ceil(((win + 1) * LIMITS.windowMs - now) / 1000)) });
  }

  const writes = [];
  if (n.tried) writes.push(['INCRBY', K.tried, n.tried]);
  if (n.gen) writes.push(['INCRBY', K.gen, n.gen]);
  if (n.ms) writes.push(['INCRBY', K.ms, n.ms]);
  if (n.tried || g) writes.push(['SADD', K.visitors, id]);

  let result = null;
  if (g) {
    const f = evaluate(g);   // the server's score is the one that counts
    const elites = elitesFrom(top);
    const member = JSON.stringify(g);
    const known = elites.some(e => JSON.stringify(e.g) === member);
    const kept = !known && Number.isFinite(f) && (elites.length < ELITE || f > elites[elites.length - 1].f);
    const best = kept && (!elites.length || f > elites[0].f);
    if (kept) writes.push(['ZADD', K.elites, f, member], ['ZREMRANGEBYRANK', K.elites, 0, -(ELITE + 1)]);
    if (best) writes.push(['RPUSH', K.hist, JSON.stringify({ f, at: now })], ['LTRIM', K.hist, -LIMITS.hist, -1]);
    result = { f, kept, best };
  }

  // the writes and a fresh read of the state, as one transaction
  const out = await store.redis.multi([...writes, ...STATE_READS]);
  return json({ ...readState(out.slice(writes.length)), result }, 200, NO_STORE);
}

export async function handle(request, store, now = Date.now()) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return json({ error: 'use GET or POST' }, 405, { ...NO_STORE, Allow: 'GET, HEAD, POST' });
  if (!store) return bad('shared training is not set up', 503);
  try {
    if (method === 'POST') return await report(request, store, now);
    return json(readState(await store.redis.pipeline(STATE_READS)), 200, CACHED);
  } catch (err) {
    console.error('[api/gait] store error:', err && err.message);
    return bad('store unavailable', 503);
  }
}

let store;
export default {
  fetch(request) {
    if (store === undefined) store = storeFromEnv();
    return handle(request, store);
  }
};
