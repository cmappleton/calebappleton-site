/* A fingerprint of the sim's exact output, to compare JavaScript engines.
   It scores 200 random gaits and 200 more from a short search (so some walk the full ten
   seconds), runs dsin over a sweep of inputs, and hashes every bit of every result.
   Everything here, the random numbers included, uses only operations that are exact in
   every engine, so any engine that disagrees has a sim that isn't deterministic.
   Run it in Node or Deno, in JavaScriptCore (jsc -m test/fingerprint-cli.js), or in a
   browser at /test/determinism.html. */
import { randomGenome, clampGenome, evaluate, dsin, RANGE, GLEN } from '../js/gaitsim.js';

export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fingerprint(seed = 20261123) {
  const rand = mulberry32(seed);
  const view = new DataView(new ArrayBuffer(8));
  let h = 0x811c9dc5;   // FNV-1a over the bytes of each double
  const mix = x => { view.setFloat64(0, x, true); for (let b = 0; b < 8; b++) { h ^= view.getUint8(b); h = Math.imul(h, 0x01000193) >>> 0; } };

  let pop = [];
  for (let i = 0; i < 200; i++) { const g = randomGenome(rand); const f = evaluate(g); mix(f); pop.push({ g, f }); }
  for (let gen = 0; gen < 10; gen++) {
    pop.sort((a, b) => b.f - a.f);
    pop = pop.slice(0, 5);
    for (let k = 0; k < 20; k++) {
      const g = pop[k % 5].g.slice();
      for (let i = 0; i < GLEN; i++) { const [lo, hi] = RANGE(i); g[i] += (rand() - 0.5) * (hi - lo) * 0.1; }
      clampGenome(g);
      const f = evaluate(g); mix(f); pop.push({ g, f });
    }
  }
  for (let i = 0; i < 20000; i++) mix(dsin(-40 + i * 0.0137));
  pop.sort((a, b) => b.f - a.f);
  return { hash: h.toString(16).padStart(8, '0'), best: pop[0].f, bestGait: pop[0].g };
}
