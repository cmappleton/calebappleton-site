/* Robot training is shared: every visitor trains the same robot dog.
   This keeps the page in step with /api/gait/. On load it fetches the shared best gaits and
   adds them to this browser's population. Training then runs locally exactly as before, and
   every so often (and when the page is hidden or closed) it reports how much it tried, plus its
   best gait when that could make the shared top five. The server re-scores that gait itself.

   If the API can't be reached, nothing is merged or sent and the page trains on its own, the
   way it did before sharing. No cookies: a random id in localStorage counts distinct visitors. */
import { evaluate, validGenome, ELITE } from './gaitsim.js';

const API = '/api/gait/';
const KEY = 'calebappleton.gait.share';
const FIRST = 20e3, EVERY = 60e3, SOON = 10e3;          // first report, then every minute; sooner for a new shared best
const CAP = { tried: 5000, gen: 400, ms: 600000 };     // the most the server takes in one report
const zero = () => ({ tried: 0, gen: 0, ms: 0 });
const keyOf = g => JSON.stringify(g);

function newId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
}

function loadMe() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem(KEY)); } catch (_) {}
  const me = { id: '', pend: zero(), mine: zero() };
  if (d && typeof d.id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(d.id)) me.id = d.id;
  for (const part of ['pend', 'mine']) {
    for (const k of Object.keys(me[part])) { const v = d && d[part] && d[part][k]; if (Number.isSafeInteger(v) && v > 0) me[part][k] = v; }
  }
  if (!me.id) me.id = newId();
  return me;
}

function parseState(d) {
  if (!d || typeof d !== 'object' || !Array.isArray(d.elites)) return null;
  const n = v => (Number.isFinite(v) && v > 0 ? v : 0);
  return {
    elites: d.elites.filter(e => e && validGenome(e.g) && Number.isFinite(e.f)).slice(0, ELITE),
    gen: n(d.gen), tried: n(d.tried), ms: n(d.ms), visitors: n(d.visitors),
    hist: Array.isArray(d.hist) ? d.hist.filter(e => e && Number.isFinite(e.f)) : []
  };
}

/* getSt returns the page's live training state ({ gen, tried, ms, elites }), which it may
   replace wholesale. onShared(added) runs whenever shared state arrives; added is true when
   it brought gaits this browser didn't have. */
export function connectShare(getSt, { onShared } = {}) {
  const me = loadMe();
  const flight = zero();               // reported but not yet answered
  let shared = null, solo = false, busy = false, lastG = '';
  let last = counts(getSt()), lastSend = 0, nextTry = 0, fails = 0;
  const born = Date.now();

  function counts(st) { return { tried: st.tried, gen: st.gen, ms: Math.floor(st.ms) }; }
  // fold the training done since the last look into what's waiting to be reported
  function note() {
    const cur = counts(getSt());
    if (cur.tried >= last.tried && cur.gen >= last.gen && cur.ms >= last.ms) {
      for (const k in cur) { const d = cur[k] - last[k]; me.pend[k] += d; me.mine[k] += d; }
    }
    last = cur;   // a drop means the page started over: nothing to add
  }
  function persist() { try { localStorage.setItem(KEY, JSON.stringify(me)); } catch (_) {} }

  // add shared gaits this browser doesn't have, scored here with the same sim as the server
  function merge(elites) {
    if (solo) return false;
    const st = getSt(), have = new Set(st.elites.map(e => keyOf(e.g)));
    let added = false;
    for (const e of elites) {
      const k = keyOf(e.g);
      if (have.has(k)) continue;
      const f = evaluate(e.g);
      if (f !== e.f) console.warn(`[robot training] a shared gait scored ${f} here and ${e.f} on the server`);
      st.elites.push({ g: e.g.slice(), f });
      have.add(k); added = true;
    }
    if (added) { st.elites.sort((a, b) => b.f - a.f); st.elites.length = Math.min(st.elites.length, ELITE); }
    return added;
  }

  function accept(data) {
    const s = parseState(data);
    if (!s) return false;
    shared = s;
    const added = merge(s.elites);
    if (onShared) onShared(added);
    return true;
  }

  function failed() {
    fails++;
    nextTry = Date.now() + Math.min(300e3, 15e3 * 2 ** (fails - 1));
  }

  async function call(opts) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch(API, { ...opts, signal: ctl.signal });
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return { ok: res.ok, status: res.status, data };
    } finally { clearTimeout(timer); }
  }

  async function pull() {
    busy = true;
    try {
      const r = await call({ method: 'GET', headers: { Accept: 'application/json' } });
      if (!r.ok || !accept(r.data)) throw new Error(String(r.status));
      fails = 0;
    } catch (_) { failed(); }
    finally { busy = false; }
  }

  // is this browser's best gait worth sending? only if it isn't shared yet and could make the top five
  function worth(best) {
    if (!shared || !best || keyOf(best.g) === lastG) return false;
    const els = shared.elites, k = keyOf(best.g);
    if (els.some(e => keyOf(e.g) === k)) return false;
    return els.length < ELITE || best.f > els[els.length - 1].f;
  }

  async function push(leaving) {
    if (!shared || (busy && !leaving)) return;
    note();
    const body = { id: me.id };
    for (const k in CAP) body[k] = Math.min(me.pend[k], CAP[k]);
    const best = getSt().elites[0];
    if (worth(best)) body.g = best.g;
    if (!body.tried && !body.gen && !body.ms && !body.g) return;

    // count it as sent now (the page may be closing), and put it back if the report fails
    for (const k in CAP) { me.pend[k] -= body[k]; flight[k] += body[k]; }
    if (body.g) lastG = keyOf(body.g);
    persist();
    lastSend = Date.now();
    if (!leaving) busy = true;
    let ok = false;
    try {
      const r = await call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: leaving });
      for (const k in CAP) flight[k] -= body[k];
      if (r.ok) { ok = true; fails = 0; accept(r.data); }
      else if (r.status === 400 || r.status === 413) ok = true;   // the server refused this report; sending it again won't help
      else failed();
    } catch (_) {
      for (const k in CAP) flight[k] -= body[k];
      failed();
    } finally { if (!leaving) busy = false; }
    if (!ok) { for (const k in CAP) me.pend[k] += body[k]; if (body.g) lastG = ''; }
    persist();
  }

  function tick() {
    note();
    const now = Date.now();
    if (busy || now < nextTry || document.hidden) return;
    if (!shared) { if (fails < 4) pull(); return; }   // after four misses, stay local for this visit
    const best = getSt().elites[0];
    const due = now - born > FIRST && now - lastSend > EVERY;
    const newBest = worth(best) && best.f > (shared.elites.length ? shared.elites[0].f : -Infinity) && now - lastSend > SOON;
    if (due || newBest) push(false);
  }

  pull();
  setInterval(tick, 2000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) push(true); });
  window.addEventListener('pagehide', () => push(true));

  return {
    // what the readouts show: shared totals plus this browser's unreported work, or the local numbers when alone
    totals() {
      const st = getSt();
      // shared: showing everyone's numbers; solo: training from scratch; online: there is a shared robot to go back to
      if (!shared || solo) return { shared: false, solo, online: !!shared, gen: st.gen, tried: st.tried, ms: st.ms, visitors: 0, mine: me.mine.tried };
      note();
      const sum = k => shared[k] + me.pend[k] + flight[k];
      return { shared: true, solo, online: true, gen: sum('gen'), tried: sum('tried'), ms: sum('ms'), visitors: shared.visitors, mine: me.mine.tried };
    },
    // Start from scratch: train this visit from random gaits, without the shared ones; the work still counts toward the totals
    solo() { solo = true; },
    // Back to the shared best: take the shared gaits again, then fetch the latest
    rejoin() {
      if (!shared) return false;
      solo = false;
      const added = merge(shared.elites);
      if (onShared) onShared(added);
      if (!busy) pull();
      return true;
    }
  };
}
