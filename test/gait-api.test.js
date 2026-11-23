import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, upstash, storeFromEnv, LIMITS } from '../api/gait.js';
import { evaluate, randomGenome, ELITE, GLEN } from '../js/gaitsim.js';
import { memRedis, upstashServer } from './memredis.js';
import { fingerprint, mulberry32 } from './fingerprint.js';

const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
let ipCount = 0;
const freshIp = () => `10.0.${(ipCount >> 8) & 255}.${ipCount++ & 255}`;

function setup() {
  const mem = memRedis({ clock: () => T0 });
  return { mem, store: { redis: mem, salt: 'test-salt' } };
}
const get = (store, now = T0) => handle(new Request('https://calebappleton.com/api/gait/'), store, now);
function post(store, body, { ip = freshIp(), now = T0, raw } = {}) {
  return handle(new Request('https://calebappleton.com/api/gait/', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-real-ip': ip },
    body: raw !== undefined ? raw : JSON.stringify(body)
  }), store, now);
}
const id = (n = 0) => `visitor${String(n).padStart(4, '0')}`;

test('without a store it answers 503, so the page trains on its own', async () => {
  for (const res of [await get(null), await post(null, { id: id() })]) {
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
});

test('GET on an empty store', async () => {
  const { store } = setup();
  const res = await get(store);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /s-maxage=10/);
  assert.deepEqual(await res.json(), { sim: 1, elites: [], gen: 0, tried: 0, ms: 0, visitors: 0, hist: [] });
});

test('a report adds to the totals and counts the visitor once', async () => {
  const { store } = setup();
  let res = await post(store, { id: id(1), tried: 300, gen: 20, ms: 25000 });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  let d = await res.json();
  assert.equal(d.tried, 300); assert.equal(d.gen, 20); assert.equal(d.ms, 25000); assert.equal(d.visitors, 1); assert.equal(d.result, null);
  d = await (await post(store, { id: id(1), tried: 100, gen: 5, ms: 1000 })).json();
  assert.equal(d.tried, 400); assert.equal(d.visitors, 1);
  d = await (await post(store, { id: id(2), tried: 1 })).json();
  assert.equal(d.visitors, 2);
  d = await (await post(store, { id: id(3) })).json();   // nothing tried: not counted as a visitor
  assert.equal(d.visitors, 2);
  const g = await (await get(store)).json();
  assert.equal(g.tried, 401); assert.equal(g.gen, 25); assert.equal(g.ms, 26000);
});

test('the server scores the gait itself and ignores the score a browser claims', async () => {
  const { store } = setup();
  const { bestGait } = fingerprint();
  const d = await (await post(store, { id: id(), tried: 10, g: bestGait, f: 999 })).json();
  assert.equal(d.result.f, evaluate(bestGait));
  assert.notEqual(d.result.f, 999);
  assert.deepEqual(d.result, { f: evaluate(bestGait), kept: true, best: true });
  assert.equal(d.elites.length, 1);
  assert.deepEqual(d.elites[0], { g: bestGait, f: evaluate(bestGait) });
  assert.equal(d.hist.length, 1);
  assert.equal(d.hist[0].f, evaluate(bestGait));
  assert.equal(d.hist[0].at, T0);
});

test('the shared top five keeps the five best, best first, and drops the rest', async () => {
  const { store } = setup();
  const rand = mulberry32(3);
  const sent = [];
  for (let k = 0; k < 12; k++) {
    const g = randomGenome(rand);
    sent.push({ g, f: evaluate(g) });
    const res = await post(store, { id: id(k), tried: 1, g });
    assert.equal(res.status, 200);
  }
  const d = await (await get(store)).json();
  const want = sent.sort((a, b) => b.f - a.f).slice(0, ELITE);
  assert.equal(d.elites.length, ELITE);
  assert.deepEqual(d.elites.map(e => e.f), want.map(e => e.f));
  assert.deepEqual(d.elites.map(e => e.g), want.map(e => e.g));
  // history only grows on a new best, so it rises and ends at the best
  assert.ok(d.hist.length >= 1 && d.hist.length <= 12);
  assert.deepEqual(d.hist.map(h => h.f), [...d.hist.map(h => h.f)].sort((a, b) => a - b), 'history rises');
  assert.equal(d.hist.at(-1).f, want[0].f);
});

test('a gait already in the top five, or below the fifth, is not kept', async () => {
  const { store } = setup();
  const rand = mulberry32(5);
  const gs = Array.from({ length: 40 }, () => randomGenome(rand)).map(g => ({ g, f: evaluate(g) })).sort((a, b) => b.f - a.f);
  for (const e of gs.slice(0, ELITE)) await post(store, { id: id(), tried: 1, g: e.g });
  let d = await (await post(store, { id: id(), tried: 1, g: gs[0].g })).json();
  assert.deepEqual(d.result, { f: gs[0].f, kept: false, best: false });
  d = await (await post(store, { id: id(), tried: 1, g: gs[30].g })).json();
  assert.equal(d.result.kept, false);
  assert.equal(d.elites.length, ELITE);
  assert.deepEqual(d.elites.map(e => e.f), gs.slice(0, ELITE).map(e => e.f));
});

test('bad reports get 400 and change nothing', async () => {
  const { store, mem } = setup();
  const g = randomGenome(mulberry32(9));
  const cases = [
    { id: 'short' },
    { id: 'has spaces in it' },
    { id: 12345678 },
    { id: id(), tried: -1 },
    { id: id(), tried: 1.5 },
    { id: id(), gen: '3' },
    { id: id(), ms: 2 ** 60 },
    { id: id(), g: g.slice(0, GLEN - 1) },
    { id: id(), g: [...g, 0.5] },
    { id: id(), g: Object.assign(g.slice(), { 0: 5 }) },
    { id: id(), g: Object.assign(g.slice(), { 2: 7 }) },
    { id: id(), g: Object.assign(g.slice(), { 3: '0.1' }) },
    { id: id(), g: Object.assign(g.slice(), { 3: null }) },
    { id: id(), g: 'not a gait' },
    [1, 2, 3],
    null
  ];
  for (const body of cases) {
    const res = await post(store, body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.ok((await res.json()).error);
  }
  assert.equal((await post(store, null, { raw: '{not json' })).status, 400);
  assert.equal((await post(store, null, { raw: JSON.stringify({ id: id(), pad: 'x'.repeat(LIMITS.body) }) })).status, 413);
  const put = await handle(new Request('https://calebappleton.com/api/gait/', { method: 'PUT', body: '{}' }), store, T0);
  assert.equal(put.status, 405);
  assert.equal(mem.calls.length, 0, 'nothing reached the store');
});

test('oversized counts are capped, not trusted', async () => {
  const { store } = setup();
  const d = await (await post(store, { id: id(), tried: 1e9, gen: 1e9, ms: 1e12 })).json();
  assert.equal(d.tried, LIMITS.tried); assert.equal(d.gen, LIMITS.gen); assert.equal(d.ms, LIMITS.ms);
});

test('-0 in a gait is stored as 0', async () => {
  const { store, mem } = setup();
  const g = randomGenome(mulberry32(13)); g[1] = 0;   // an amplitude, whose range starts at 0
  const raw = JSON.stringify({ id: id(), tried: 1, g }).replace(/("g":\[[^,]+,)0,/, '$1-0,');
  assert.match(raw, /"g":\[[^,]+,-0,/);
  const d = await (await post(store, null, { raw })).json();
  assert.equal(d.result.kept, true);
  const members = [...mem.data.get('gait:1:elites').v.keys()];
  assert.ok(members.every(m => !m.includes('-0,')), members[0]);
  assert.equal(d.result.f, evaluate(g));
});

test('rate limit: twelve reports a minute per IP, then 429 until the next minute', async () => {
  const { store, mem } = setup();
  const ip = '203.0.113.7';
  for (let k = 0; k < LIMITS.posts; k++) assert.equal((await post(store, { id: id(), tried: 1 }, { ip, now: T0 + k })).status, 200);
  const res = await post(store, { id: id(), tried: 1 }, { ip, now: T0 + 30_000 });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '30');
  assert.equal((await post(store, { id: id(), tried: 1 }, { ip: '203.0.113.8', now: T0 + 30_000 })).status, 200, 'another IP is fine');
  assert.equal((await post(store, { id: id(), tried: 1 }, { ip, now: T0 + 60_000 })).status, 200, 'next minute is fine');
  // the refused report added nothing, and no key holds the raw IP
  assert.equal((await (await get(store)).json()).tried, LIMITS.posts + 2);
  assert.ok([...mem.data.keys()].every(k => !k.includes('203.0.113')));
  const rl = [...mem.data.entries()].filter(([k]) => k.includes(':rl:'));
  assert.ok(rl.length === 3 && rl.every(([, e]) => e.exp === T0 + 120_000), 'rate-limit keys expire after two minutes');
});

test('a store outage answers 503 instead of throwing', async () => {
  const { store, mem } = setup();
  mem.failing = true;
  assert.equal((await get(store)).status, 503);
  assert.equal((await post(store, { id: id(), tried: 1 })).status, 503);
});

test('storeFromEnv reads the Upstash integration variables, under either name', () => {
  assert.equal(storeFromEnv({}), null);
  assert.equal(storeFromEnv({ KV_REST_API_URL: 'https://x.upstash.io' }), null);
  assert.ok(storeFromEnv({ KV_REST_API_URL: 'https://x.upstash.io', KV_REST_API_TOKEN: 't' }));
  assert.ok(storeFromEnv({ UPSTASH_REDIS_REST_URL: 'https://x.upstash.io', UPSTASH_REDIS_REST_TOKEN: 't' }));
});

test('over HTTP: the Upstash REST client talks to /pipeline and /multi-exec with a bearer token', async () => {
  const mem = memRedis({ clock: () => T0 });
  const { server, requests, url } = await upstashServer(mem, 'secret-token');
  try {
    const store = { redis: upstash(url + '/', 'secret-token'), salt: 'secret-token' };
    const { bestGait } = fingerprint();
    let res = await post(store, { id: id(), tried: 7, gen: 1, ms: 900, g: bestGait });
    assert.equal(res.status, 200);
    let d = await res.json();
    assert.equal(d.result.f, evaluate(bestGait));
    assert.equal(d.elites[0].f, evaluate(bestGait), 'the score comes back exactly through Redis score text');
    d = await (await get(store)).json();
    assert.equal(d.tried, 7); assert.equal(d.visitors, 1); assert.deepEqual(d.elites[0].g, bestGait);
    assert.deepEqual(requests.map(r => r.url), ['/pipeline', '/multi-exec', '/pipeline']);
    assert.ok(requests.every(r => r.method === 'POST' && r.auth === 'Bearer secret-token'));
    const wrong = { redis: upstash(url, 'wrong-token'), salt: 'x' };
    assert.equal((await get(wrong)).status, 503);
  } finally { server.close(); }
});
