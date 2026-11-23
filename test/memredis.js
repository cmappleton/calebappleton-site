/* An in-memory stand-in for Upstash Redis, for tests and local runs without credentials.
   memRedis() answers the handful of commands api/gait.js uses, with Redis semantics and
   Upstash's REST reply shapes (strings for bulk replies, numbers for integers).
   upstashServer() puts it behind Upstash's REST endpoints (/pipeline and /multi-exec) so the
   real client in api/gait.js can be tested over HTTP. */
import { createServer } from 'node:http';

export function memRedis({ clock = () => Date.now() } = {}) {
  const data = new Map();   // key -> { type, v, exp }
  const live = key => { const e = data.get(key); if (e && e.exp && e.exp <= clock()) { data.delete(key); return undefined; } return e; };
  const want = (key, type, make) => {
    let e = live(key);
    if (!e) { e = { type, v: make() }; data.set(key, e); }
    if (e.type !== type) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    return e;
  };
  const int = s => { const n = Number(s); if (!Number.isSafeInteger(n)) throw new Error('ERR value is not an integer or out of range'); return n; };
  const span = (len, a, b) => {   // Redis start/stop with negative indexes
    a = int(a); b = int(b);
    if (a < 0) a = Math.max(0, len + a);
    if (b < 0) b = len + b;
    if (b >= len) b = len - 1;
    return a > b ? null : [a, b];
  };
  const fmt = f => f.toPrecision(17);   // Redis replies with long score text such as "7.8210000000000002"
  const zsorted = e => [...e.v.entries()].sort((p, q) => p[1] - q[1] || (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0));

  const cmds = {
    GET: k => { const e = live(k); if (e && e.type !== 'string') throw new Error('WRONGTYPE'); return e ? e.v : null; },
    MGET: (...ks) => ks.map(k => { const e = live(k); return e && e.type === 'string' ? e.v : null; }),
    INCRBY: (k, n) => { const e = want(k, 'string', () => '0'); e.v = String(int(e.v) + int(n)); return Number(e.v); },
    INCR: k => cmds.INCRBY(k, 1),
    EXPIRE: (k, s) => { const e = live(k); if (!e) return 0; e.exp = clock() + int(s) * 1000; return 1; },
    SADD: (k, ...ms) => { const e = want(k, 'set', () => new Set()); let n = 0; for (const m of ms) if (!e.v.has(String(m))) { e.v.add(String(m)); n++; } return n; },
    SCARD: k => { const e = live(k); return e ? e.v.size : 0; },
    ZADD: (k, score, m) => { const e = want(k, 'zset', () => new Map()); const f = Number(score); if (Number.isNaN(f)) throw new Error('ERR value is not a valid float'); const isNew = !e.v.has(String(m)); e.v.set(String(m), f); return isNew ? 1 : 0; },
    ZREVRANGE: (k, a, b, opt) => {
      const e = live(k); if (!e) return [];
      const all = zsorted(e).reverse(), r = span(all.length, a, b); if (!r) return [];
      const out = [];
      for (const [m, f] of all.slice(r[0], r[1] + 1)) { out.push(m); if (String(opt).toUpperCase() === 'WITHSCORES') out.push(fmt(f)); }
      return out;
    },
    ZREMRANGEBYRANK: (k, a, b) => {
      const e = live(k); if (!e) return 0;
      const all = zsorted(e), r = span(all.length, a, b); if (!r) return 0;
      for (const [m] of all.slice(r[0], r[1] + 1)) e.v.delete(m);
      if (!e.v.size) data.delete(k);
      return r[1] - r[0] + 1;
    },
    RPUSH: (k, ...vs) => { const e = want(k, 'list', () => []); e.v.push(...vs.map(String)); return e.v.length; },
    LRANGE: (k, a, b) => { const e = live(k); if (!e) return []; const r = span(e.v.length, a, b); return r ? e.v.slice(r[0], r[1] + 1) : []; },
    LTRIM: (k, a, b) => { const e = live(k); if (!e) return 'OK'; const r = span(e.v.length, a, b); e.v = r ? e.v.slice(r[0], r[1] + 1) : []; if (!e.v.length) data.delete(k); return 'OK'; }
  };

  function exec([name, ...args]) {
    const fn = cmds[String(name).toUpperCase()];
    if (!fn) return { error: `ERR unknown command '${name}'` };
    try { return { result: fn(...args) }; } catch (err) { return { error: err.message }; }
  }
  const unwrap = out => out.map(r => { if (r.error) throw new Error(r.error); return r.result; });
  const mem = {
    data, exec, failing: false, calls: [],
    // the same interface api/gait.js gets from upstash(): arrays of results, throwing on errors
    pipeline: async list => { if (mem.failing) throw new Error('store down'); mem.calls.push(['pipeline', list]); return unwrap(list.map(exec)); },
    multi: async list => { if (mem.failing) throw new Error('store down'); mem.calls.push(['multi', list]); return unwrap(list.map(exec)); }
  };
  return mem;
}

// Upstash's REST API in front of a memRedis: POST /pipeline and POST /multi-exec, bearer token auth.
export function upstashServer(mem, token) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: raw });
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' });
    if (req.method !== 'POST' || (req.url !== '/pipeline' && req.url !== '/multi-exec')) return send(404, { error: 'Not found' });
    let list;
    try { list = JSON.parse(raw); } catch (_) { return send(400, { error: 'bad json' }); }
    if (!Array.isArray(list) || !list.every(Array.isArray)) return send(400, { error: 'expected an array of commands' });
    send(200, list.map(mem.exec));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` })));
}
