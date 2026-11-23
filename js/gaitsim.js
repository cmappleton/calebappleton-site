/* The robot dog's body, physics and scoring. The page (js/walker.js) and the server
   (api/gait.js) both run this file, so a gait gets the same score in every browser and on
   the server.

   The sim is chaotic: a change in the last bit of one number changes the whole walk. So it
   uses only operations that give the same bits in every JavaScript engine: +, -, *, / (exactly
   rounded by the language spec), Math.sqrt (exactly rounded IEEE 754 square root everywhere),
   Math.floor, Math.min, Math.max and %. Math.sin and Math.hypot are left to each engine and
   differ between V8, JavaScriptCore and SpiderMonkey, so this file has its own sine and uses
   sqrt instead of hypot.

   Change anything that affects a score and SIM_VERSION must go up, or the shared top gaits
   would be compared under two different rule sets. */

export const SIM_VERSION = 1;

/* ---------- body plan ---------- */
export const BONES = [[0, 1], [0, 2], [1, 2], [0, 3], [3, 4], [1, 5], [5, 6], [0, 7], [7, 8], [1, 9], [9, 10]];
export const MUSCLES = [[2, 3], [0, 4], [2, 5], [1, 6], [2, 7], [0, 8], [2, 9], [1, 10]];
export const FEET = new Set([4, 6, 8, 10]);
export const LEGS = [[0, 3, 4, true], [1, 5, 6, true], [0, 7, 8, false], [1, 9, 10, false]];   // hip, knee, foot, near?
export const N = 11, NM = MUSCLES.length, TH = 1 + NM * 3, SH = TH + 1, GLEN = SH + 1;
export const DT = 1 / 120, G = 9.81, ITER = 8, TRIAL = 10, STEPS = Math.round(TRIAL / DT);
export const ELITE = 5;   // how many of the best gaits are kept

const PI = Math.PI, TAU = Math.PI * 2, HALF_PI = Math.PI / 2;
const isPhase = i => i > 0 && i < TH && (i - 1) % 3 === 1;
export const RANGE = i => i === 0 ? [0.5, 1.8] : i >= TH ? [0.8, 1.25] : ((i - 1) % 3 === 0 ? [0, 0.2] : (i - 1) % 3 === 1 ? [0, TAU] : [-0.12, 0.12]);

/* ---------- a sine that gives the same bits everywhere ----------
   Reduce to [-pi/2, pi/2], then the Taylor series to x^21 (error below 1e-17 there).
   The coefficients are built with exact-rounding division so they match bit for bit too. */
const SIN_C = [1];
for (let k = 1; k <= 10; k++) SIN_C.push(-SIN_C[k - 1] / ((2 * k) * (2 * k + 1)));

export function dsin(x) {
  let r = x - Math.floor(x / TAU + 0.5) * TAU;
  if (r > HALF_PI) r = PI - r;
  else if (r < -HALF_PI) r = -PI - r;
  const r2 = r * r;
  let p = SIN_C[10];
  for (let k = 9; k >= 0; k--) p = p * r2 + SIN_C[k];
  return r * p;
}

/* ---------- genomes ----------
   g[0] is the stride frequency, then three numbers per muscle (amplitude, phase, offset),
   then the thigh and shin lengths. */
export function randomGenome(rand = Math.random) {
  const g = new Array(GLEN);
  for (let i = 0; i < GLEN; i++) { const [a, b] = RANGE(i); g[i] = a + rand() * (b - a); }
  return g;
}
export function clampGenome(g) {
  for (let i = 0; i < GLEN; i++) {
    const [a, b] = RANGE(i);
    if (isPhase(i)) g[i] = ((g[i] % TAU) + TAU) % TAU;
    else g[i] = Math.max(a, Math.min(b, g[i]));
  }
  return g;
}
// true when g is exactly what clampGenome could produce: the right length, all finite, all in range
export function validGenome(g) {
  if (!Array.isArray(g) || g.length !== GLEN) return false;
  for (let i = 0; i < GLEN; i++) {
    const v = g[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    const [a, b] = RANGE(i);
    if (isPhase(i) ? !(v >= 0 && v < TAU) : !(v >= a && v <= b)) return false;
  }
  return true;
}

/* ---------- the Verlet spring-mass sim ---------- */
export function makeSim(g) {
  const th = 0.42 * g[TH], sh = 0.42 * g[SH], hipY = th + sh + 0.02, L = 0.95;
  const pos = [[0, hipY], [L, hipY], [L / 2, hipY + 0.28], [0.06, hipY - th], [0, 0.02], [L + 0.06, hipY - th], [L, 0.02], [-0.04, hipY - th], [-0.02, 0.02], [L - 0.04, hipY - th], [L - 0.02, 0.02]];
  const s = { x: new Float64Array(N), y: new Float64Array(N), px: new Float64Array(N), py: new Float64Array(N), cx: new Float64Array(N), c: new Uint8Array(N), b0: [], m0: [], ml: new Float64Array(NM), t: 0, n: 0 };
  pos.forEach(([x, y], i) => { s.x[i] = s.px[i] = x; s.y[i] = s.py[i] = y; });
  const len = (a, b) => { const dx = pos[a][0] - pos[b][0], dy = pos[a][1] - pos[b][1]; return Math.sqrt(dx * dx + dy * dy); };
  s.b0 = BONES.map(([a, b]) => len(a, b));
  s.m0 = MUSCLES.map(([a, b]) => len(a, b));
  s.th = th; s.sh = sh;
  return s;
}

function solve(s, a, b, L, k) {
  const dx = s.x[b] - s.x[a], dy = s.y[b] - s.y[a];
  const d = Math.sqrt(dx * dx + dy * dy) || 1e-9;
  const f = (d - L) / d * 0.5 * k;
  s.x[a] += dx * f; s.y[a] += dy * f; s.x[b] -= dx * f; s.y[b] -= dy * f;
}

export function step(s, g) {
  const { x, y, px, py, cx, c } = s;
  // planted feet stay put until a muscle lifts them
  for (let i = 0; i < N; i++) { c[i] = y[i] <= 0.001 ? 1 : 0; cx[i] = x[i]; }
  for (let i = 0; i < N; i++) {
    const vx = (x[i] - px[i]) * 0.998, vy = (y[i] - py[i]) * 0.998;
    px[i] = x[i]; py[i] = y[i];
    x[i] += vx; y[i] += vy - G * DT * DT;
  }
  const w = 2 * Math.PI * g[0] * s.t;
  for (let m = 0; m < NM; m++) s.ml[m] = s.m0[m] * (1 + g[1 + 3 * m] * dsin(w + g[2 + 3 * m]) + g[3 + 3 * m]);
  for (let it = 0; it < ITER; it++) {
    for (let k = 0; k < BONES.length; k++) solve(s, BONES[k][0], BONES[k][1], s.b0[k], 1);
    for (let m = 0; m < NM; m++) solve(s, MUSCLES[m][0], MUSCLES[m][1], s.ml[m], 0.18);
    for (let i = 0; i < N; i++) {
      if (y[i] < 0) y[i] = 0;
      if (c[i] && FEET.has(i) && y[i] <= 0.002) x[i] = cx[i];
    }
  }
  for (let i = 0; i < N; i++) {
    if (y[i] <= 0.0005) {
      if (!FEET.has(i)) x[i] = px[i] + (x[i] - px[i]) * 0.2;
      py[i] = y[i];
      if (FEET.has(i)) px[i] = x[i];
    }
  }
  s.t += DT; s.n++;
}

export const fallen = s => s.y[2] < 0.25 || s.y[0] < 0.08 || s.y[1] < 0.08 || s.y[2] < Math.min(s.y[0], s.y[1]);
export const score = (dist, fell) => fell ? dist * 0.4 - 0.5 : dist;   // falling costs most of the distance

// distance travelled in TRIAL seconds, scored
export function evaluate(g) {
  const s = makeSim(g);
  const x0 = (s.x[0] + s.x[1]) / 2;
  for (let i = 0; i < STEPS; i++) {
    step(s, g);
    if (fallen(s)) return score((s.x[0] + s.x[1]) / 2 - x0, true);
    if ((i & 127) === 0 && !isFinite(s.x[0])) return -10;
  }
  return score((s.x[0] + s.x[1]) / 2 - x0, false);
}
