/* Robot training: a four-legged walker that learns to move while the page is open.
   The body is a Verlet spring-mass model; each gait is a set of muscle rhythms.
   A small evolutionary loop keeps whatever travels farthest in ten seconds.
   This browser's progress is saved in localStorage, and gaitshare.js shares the best gaits
   with every other visitor through /api/gait/. */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as C from './cell3d.js';

// Vercel Web Analytics. The stub in the page's <head> queues events until its script loads.
const track = (name, data) => { try { if (window.va) window.va('event', { name, data }); } catch (_) {} };

const view = document.getElementById('rig-canvas');
if (view) init();

/* ---------- the body, physics and scoring live in gaitsim.js, which the server runs too ---------- */
import { LEGS, GLEN, TRIAL, STEPS, ELITE, RANGE, randomGenome, clampGenome, makeSim, step, fallen, score, evaluate } from './gaitsim.js';
// every visitor trains the same robot: gaitshare.js seeds from the shared best gaits and reports back
import { connectShare } from './gaitshare.js';

/* ---------- training state ---------- */
const KEY = 'calebappleton.gait.v2';
const POP = 20;

function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.v === 1 && Array.isArray(d.elites) && d.elites.length) return d; } catch (_) {}
  return null;
}
function save(st) {
  try { localStorage.setItem(KEY, JSON.stringify({ v: 1, gen: st.gen, tried: st.tried, ms: st.ms, elites: st.elites, hist: st.hist })); } catch (_) {}
}

function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

function children(st) {
  const kids = [];
  const anneal = Math.max(0.22, 1 / (1 + st.gen / 260));
  const pick = () => st.elites[Math.floor(Math.pow(Math.random(), 2) * st.elites.length)];
  while (kids.length < POP - ELITE) {
    const a = pick().g.slice();
    if (Math.random() < 0.3) { const b = pick().g; for (let i = 0; i < GLEN; i++) if (Math.random() < 0.5) a[i] = b[i]; }
    const big = Math.random() < 0.08 ? 4 : 1;
    for (let i = 0; i < GLEN; i++) if (Math.random() < 0.35) { const [lo, hi] = RANGE(i); a[i] += gauss() * (hi - lo) * 0.08 * anneal * big; }
    kids.push(clampGenome(a));
  }
  return kids;
}

/* ---------- page ---------- */
async function init() {
  const els = {
    gen: document.getElementById('rig-gen'), best: document.getElementById('rig-best'),
    tried: document.getElementById('rig-tried'), time: document.getElementById('rig-time'),
    pause: document.getElementById('rig-pause'), reset: document.getElementById('rig-reset'), play: document.getElementById('rig-play'),
    back: document.getElementById('rig-back'),
    chart: document.getElementById('rig-chart'),
    visitors: document.getElementById('rig-visitors'), mine: document.getElementById('rig-mine')   // shared readouts, if the page has them
  };
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try { await document.fonts.load('extra-condensed 800 20px Archivo'); } catch (_) {}

  let st = load();
  if (!st) st = { gen: 0, tried: 0, ms: 0, elites: [], hist: [] };
  st.elites = st.elites.map(e => ({ g: e.g, f: evaluate(e.g) })).sort((a, b) => b.f - a.f);
  let queue = st.elites.length ? children(st) : Array.from({ length: POP }, randomGenome);
  let evaluated = [];
  let paused = false, genStart = performance.now();

  /* training runs in short time slices while the page is visible */
  let lastTick = performance.now();
  function train() {
    const t = performance.now();
    if (!document.hidden && !paused) st.ms += Math.min(250, t - lastTick);
    lastTick = t;
    if (!document.hidden && !paused) {
      const budget = t + 6;
      while (queue.length && performance.now() < budget) {
        const g = queue.pop();
        evaluated.push({ g, f: evaluate(g) });
        st.tried++;
      }
      if (!queue.length && performance.now() - genStart > 1100) {
        const pool = [...st.elites, ...evaluated].sort((a, b) => b.f - a.f);
        st.elites = pool.slice(0, ELITE).map(e => ({ g: e.g.slice(), f: e.f }));
        evaluated = [];
        st.gen++;
        st.hist.push(+st.elites[0].f.toFixed(3));
        if (st.hist.length > 400) st.hist = st.hist.filter((_, i) => i % 2 === 0);
        queue = children(st);
        genStart = performance.now();
        if (st.gen % 5 === 0) save(st);
      }
    }
    setTimeout(train, 40);
  }
  train();
  window.addEventListener('pagehide', () => save(st));
  document.addEventListener('visibilitychange', () => { if (document.hidden) save(st); });

  /* the shared robot: when shared gaits beat the one on screen, replay the new best */
  const share = connectShare(() => st, {
    onShared(added) {
      if (added && st.elites.length && st.elites[0].f > replay.f) { replay.start(); if (!replay.playing) render(); }
      readouts();
    }
  });

  /* ---------- readouts ---------- */
  const fmtTime = ms => { const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60; return h ? `${h} h ${m} min` : m ? `${m} min ${r} s` : `${r} s`; };
  function readouts() {
    const t = share.totals();   // everyone's totals when shared, this browser's otherwise
    els.gen.textContent = t.gen.toLocaleString();
    els.best.textContent = st.elites.length ? `${Math.max(0, st.elites[0].f).toFixed(2)} m` : '0.00 m';
    els.tried.textContent = t.tried.toLocaleString();
    els.time.textContent = fmtTime(t.ms);
    if (els.visitors) { els.visitors.textContent = t.visitors.toLocaleString(); els.visitors.parentNode.hidden = !t.shared; }
    if (els.mine) { els.mine.textContent = t.mine.toLocaleString(); els.mine.parentNode.hidden = !t.shared; }
    if (els.back) els.back.hidden = !(t.solo && t.online);
    drawChart();
  }
  function drawChart() {
    const c = els.chart, dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const pad = { l: 42, r: 12, t: 12, b: 20 };
    g.strokeStyle = '#1D2766'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(pad.l, pad.t); g.lineTo(pad.l, h - pad.b); g.lineTo(w - pad.r, h - pad.b); g.stroke();
    g.fillStyle = '#555D8B'; g.font = '600 11px Archivo, sans-serif';
    g.fillText('Best distance by generation', pad.l + 6, pad.t + 9);
    const hist = st.hist;
    if (hist.length < 2) return;
    const max = Math.max(1, ...hist), min = Math.min(0, ...hist);
    g.textAlign = 'right';
    g.fillText(`${max.toFixed(1)} m`, pad.l - 4, pad.t + 9);
    g.fillText('0', pad.l - 4, h - pad.b);
    g.textAlign = 'left';
    g.strokeStyle = '#1D2766'; g.lineWidth = 1.6;
    g.beginPath();
    hist.forEach((v, i) => {
      const x = pad.l + (w - pad.l - pad.r) * i / (hist.length - 1);
      const y = (h - pad.b) - (h - pad.t - pad.b - 14) * (v - min) / (max - min || 1);
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    });
    g.stroke();
  }
  readouts();
  setInterval(readouts, 400);

  els.pause.addEventListener('click', () => {
    paused = !paused;
    els.pause.textContent = paused ? 'Resume training' : 'Pause training';
    if (paused) save(st);
  });
  let armed = 0;
  els.reset.addEventListener('click', () => {
    if (!armed) {
      els.reset.classList.add('is-armed'); els.reset.textContent = 'Click again to start from scratch';
      armed = setTimeout(() => { armed = 0; els.reset.classList.remove('is-armed'); els.reset.textContent = 'Start from scratch'; }, 3000);
      return;
    }
    clearTimeout(armed); armed = 0;
    els.reset.classList.remove('is-armed'); els.reset.textContent = 'Start from scratch';
    try { localStorage.removeItem(KEY); } catch (_) {}
    share.solo();   // this visit now trains from scratch; the shared robot keeps its progress
    st = { gen: 0, tried: 0, ms: 0, elites: [], hist: [] };
    queue = Array.from({ length: POP }, randomGenome); evaluated = []; genStart = performance.now();
    replay.start(true);
    readouts();
  });
  // after starting from scratch, this takes the shared best gaits again (the button only shows when there's a shared robot)
  if (els.back) els.back.addEventListener('click', () => {
    if (share.rejoin()) { replay.start(true); if (!replay.playing) render(); }
    readouts();
    els.reset.focus();   // the button hides itself, so keep keyboard focus nearby
  });

  /* ---------- the 3D replay of the best gait ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, canvas: view, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  const host = view.parentNode;
  host.style.position = 'relative';
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  host.appendChild(overlay);
  const TILT = 0.2, CT = Math.cos(TILT), ST = Math.sin(TILT);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  camera.rotation.x = -TILT;
  let scene, pen, rig, W, H, viewW = 5.2, camX = 0.5;

  function buildScene() {
    W = view.clientWidth; H = view.clientHeight;
    renderer.setSize(W, H, false);
    pen = new C.Pen(renderer, { mode: 'tone' });
    scene = new THREE.Scene();
    const ground = pen.solid(new THREE.BoxGeometry(400, 1.2, 1.8), 0.05, { threshold: 30 });
    ground.position.set(150, -0.6, 0.3); scene.add(ground);
    rig = null;
    viewW = Math.max(3.6, Math.min(6.5, W / 120));
    overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
  }

  function buildRig(sim) {
    if (rig) scene.remove(rig.root);
    const root = new THREE.Group();
    const torso = new THREE.Group();
    torso.add(pen.solid(new RoundedBoxGeometry(1.08, 0.26, 0.5, 3, 0.05), 0.58));
    const panel = pen.solid(new THREE.BoxGeometry(0.82, 0.14, 0.02), 0.08); panel.position.z = 0.256; torso.add(panel);
    const head = pen.solid(new RoundedBoxGeometry(0.18, 0.22, 0.34, 3, 0.04), 0.62); head.position.set(0.62, 0.02, 0); torso.add(head);
    const handle = pen.solid(new THREE.TorusGeometry(0.1, 0.02, 8, 24, Math.PI), 0.85, { threshold: 70 }); handle.position.set(-0.22, 0.13, 0); torso.add(handle);
    root.add(torso);
    const legs = LEGS.map(([hip, knee, foot, near]) => {
      const z = near ? 0.3 : -0.3;
      const thigh = pen.solid(new THREE.CapsuleGeometry(0.05, sim.th, 4, 12), near ? 0.12 : 0.32, { edges: false });
      const shin = pen.solid(new THREE.CapsuleGeometry(0.032, sim.sh, 4, 12), near ? 0.86 : 0.92, { edges: false });
      const kj = pen.solid(new THREE.CylinderGeometry(0.058, 0.058, 0.07, 18).rotateX(Math.PI / 2), 0.7);
      const ft = pen.solid(new THREE.SphereGeometry(0.05, 14, 10), 0.85, { edges: false });
      const hp = pen.solid(new THREE.CylinderGeometry(0.085, 0.085, 0.08, 20).rotateX(Math.PI / 2), near ? 0.2 : 0.4);
      [thigh, shin, kj, ft, hp].forEach(m => root.add(m));
      return { hip, knee, foot, z, thigh, shin, kj, ft, hp };
    });
    scene.add(root);
    rig = { root, torso, legs, th: sim.th, sh: sim.sh };
  }

  const up = new THREE.Vector3(0, 1, 0), tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3();
  function poseRig(s) {
    const x0 = s.x[0], y0 = s.y[0], x1 = s.x[1], y1 = s.y[1];
    rig.torso.position.set((x0 + x1) / 2, (y0 + y1) / 2 + 0.05, 0);
    rig.torso.rotation.z = Math.atan2(y1 - y0, x1 - x0);
    const place = (m, a, b, z) => {
      tmpA.set(s.x[a], s.y[a], z); tmpB.set(s.x[b], s.y[b], z);
      m.position.copy(tmpA).lerp(tmpB, 0.5);
      m.quaternion.setFromUnitVectors(up, tmpB.sub(tmpA).normalize());
    };
    rig.legs.forEach(l => {
      place(l.thigh, l.hip, l.knee, l.z);
      place(l.shin, l.knee, l.foot, l.z);
      l.kj.position.set(s.x[l.knee], s.y[l.knee], l.z);
      l.ft.position.set(s.x[l.foot], Math.max(0.05, s.y[l.foot] + 0.03), l.z);
      l.hp.position.set(s.x[l.hip], s.y[l.hip], l.z);
    });
  }

  const toScreen = (x, y, z = 0) => [(x - (camX - viewW / 2)) / viewW * W, H - 34 - (y * CT - z * ST) * (W / viewW)];

  const replay = {
    sim: null, g: null, f: 0, hold: 0, playing: !reduce, fresh: false, reported: false,
    start(force) {
      this.reported = false;
      const best = st.elites[0];
      this.g = best ? best.g : randomGenome();
      const newBest = best && best.f !== this.f;
      this.fresh = newBest && this.f !== 0;
      this.f = best ? best.f : 0;
      this.sim = makeSim(this.g);
      this.x0 = (this.sim.x[0] + this.sim.x[1]) / 2;
      this.tried = share.totals().tried;
      if (!rig || rig.th !== this.sim.th || rig.sh !== this.sim.sh || force) buildRig(this.sim);
      camX = this.x0 + 1.2;
      this.hold = 0;
    }
  };

  function drawOverlay(s) {
    const mid = (s.x[0] + s.x[1]) / 2, dist = mid - replay.x0;
    const scale = W / viewW;
    let html = '';
    const x0 = Math.floor(camX - viewW / 2 - 1), x1 = Math.ceil(camX + viewW / 2 + 1);
    for (let m = x0 * 2; m <= x1 * 2; m++) {
      const wx = replay.x0 + m / 2;
      const [X, Y] = toScreen(wx, 0, 0.55);
      const major = m % 2 === 0;
      html += `<path d="M ${X} ${Y} v ${major ? 9 : 5}" stroke="#1D2766" stroke-width="1"/>`;
      if (major && m >= 0) html += `<text x="${X + 3}" y="${Y + 9}" font-size="11" fill="#555D8B" style="font-family:Archivo;font-weight:600;font-stretch:75%">${m / 2} m</text>`;
    }
    const [sx] = toScreen(replay.x0, 0), topY = 22;
    html += `<path d="M ${sx} ${topY - 8} V ${H - 34}" stroke="#A9AFC6" stroke-dasharray="12 4 2 4" fill="none"/>`;
    const [mx] = toScreen(mid, 0);
    const fell = fallen(s), done = fell || s.n >= STEPS;
    const red = '#F0441C', redInk = '#BF2F0E', dimInk = done ? red : '#1D2766';
    if (Math.abs(mx - sx) > 14) {
      const d = mx > sx ? 1 : -1;
      html += `<path d="M ${sx} ${topY} H ${mx}" stroke="${dimInk}" stroke-width="1" fill="none"/>`;
      html += `<path d="M ${sx + d * 8} ${topY - 4} L ${sx} ${topY} L ${sx + d * 8} ${topY + 4} M ${mx - d * 8} ${topY - 4} L ${mx} ${topY} L ${mx - d * 8} ${topY + 4}" stroke="${dimInk}" stroke-width="1" fill="none"/>`;
      html += `<path d="M ${mx} ${topY - 8} V ${toScreen(mid, s.y[2] + 0.2)[1]}" stroke="#A9AFC6" stroke-width="1" fill="none"/>`;
    }
    html += `<rect x="${(sx + mx) / 2 - 30}" y="${topY - 9}" width="60" height="18" fill="#E8EAE4"/>`;
    html += `<text x="${(sx + mx) / 2}" y="${topY + 4}" text-anchor="middle" font-size="13" fill="${done ? redInk : '#1D2766'}" style="font-family:Archivo;font-weight:700;font-stretch:75%">${dist.toFixed(2)} m</text>`;
    // the run's clock, and what this gait is: the winner so far of a search
    // narrow canvases keep the score up here, clear of the robot
    const narrow = W < 560, sc = Math.max(0, score(dist, fell)).toFixed(2);
    const stack = [[done ? (fell ? `Fell at ${s.t.toFixed(1)} s` : `Finished at ${TRIAL} s`) : `t = ${s.t.toFixed(1)} s of ${TRIAL}`, done ? redInk : '#555D8B', 12, 600]];
    if (done && narrow) { stack.push([`Score ${sc} m`, redInk, 15, 800]); if (fell) stack.push(['Falling cuts the score', '#555D8B', 12, 600]); }
    // this run is the best gait as of when it started; training keeps going while it plays
    if (replay.tried) stack.push([`Best after ${replay.tried.toLocaleString()} gaits tried`, '#555D8B', 12, 600]);
    if (replay.fresh) stack.push(['New best', redInk, 12, 600]);
    const waiting = st.elites.length ? Math.max(0, st.elites[0].f).toFixed(2) : null;
    if (waiting && st.elites[0].f > replay.f && waiting !== Math.max(0, replay.f).toFixed(2)) stack.push([`Better gait found: ${waiting} m. It plays next.`, '#555D8B', 12, 600]);
    let ly = topY + 4;
    stack.forEach(([txt, fill, size, wt], i) => {
      if (i) ly += size + 4;
      html += `<text x="${W - 12}" y="${ly}" text-anchor="end" font-size="${size}" fill="${fill}" style="font-family:Archivo;font-weight:${wt};font-stretch:75%">${txt}</text>`;
    });
    // at the end of the run: a finish line where it stopped, with its score
    if (done) {
      const [, fy] = toScreen(mid, 0), flagY = topY + 50;
      const left = mx > W * 0.62, tx = left ? mx - 22 : mx + 22;
      html += `<path d="M ${mx} ${fy} V ${flagY}" stroke="${red}" stroke-width="1.5" fill="none"/>`;
      html += `<path d="M ${mx} ${flagY} l ${left ? -16 : 16} 6 l ${left ? 16 : -16} 6 z" fill="${red}"/>`;
      if (!narrow) {
        html += `<text x="${tx}" y="${flagY + 11}" text-anchor="${left ? 'end' : 'start'}" font-size="16" fill="${redInk}" style="font-family:Archivo;font-weight:800;font-stretch:75%">Score ${sc} m</text>`;
        if (fell) html += `<text x="${tx}" y="${flagY + 28}" text-anchor="${left ? 'end' : 'start'}" font-size="12" fill="#555D8B" style="font-family:Archivo;font-weight:600;font-stretch:75%">Falling cuts the score</text>`;
      }
    }
    overlay.innerHTML = html;
  }

  function render() {
    const s = replay.sim;
    const mid = (s.x[0] + s.x[1]) / 2;
    camX += (mid + 0.6 - camX) * 0.06;
    const hw = viewW / 2, hh = hw * H / W;
    camera.left = camX - hw; camera.right = camX + hw;
    camera.top = (H - 34) / (W / viewW); camera.bottom = -34 / (W / viewW);
    camera.position.set(0, 60 * ST, 60 * CT);
    camera.updateProjectionMatrix();
    poseRig(s);
    renderer.render(scene, camera);
    drawOverlay(s);
  }

  // Send how a replay ended: the first one on this visit, then only when the result changes,
  // so leaving the page open sends a couple of events instead of one every run.
  let lastResult = null;
  function reportRun(fell) {
    const result = fell ? 'Fell' : 'Finished';
    if (result === lastResult) return;
    lastResult = result;
    track('Robot training replay', { result });
  }

  let inView = false, raf = 0;
  function loop() {
    raf = 0;
    if (!inView || document.hidden) return;
    const s = replay.sim;
    if (replay.playing) {
      if (s.n < STEPS && !fallen(s)) { for (let k = 0; k < 2 && s.n < STEPS && !fallen(s); k++) step(s, replay.g); }
      else {
        if (!replay.reported) { replay.reported = true; reportRun(fallen(s)); }
        if ((replay.hold += 1 / 60) > 2.6) { replay.start(); if (reduce) replay.playing = false; }
      }
    }
    render();
    if (replay.playing || !reduce) raf = requestAnimationFrame(loop);
  }
  const kick = () => { if (!raf) raf = requestAnimationFrame(loop); };

  buildScene();
  replay.start(true);
  render();
  if (reduce && els.play) {
    els.play.hidden = false;
    els.play.addEventListener('click', () => { replay.start(); replay.playing = true; kick(); });
  }
  new IntersectionObserver(entries => { inView = entries[0].isIntersecting; if (inView) kick(); }, { threshold: 0.05 }).observe(view);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kick(); });
  let lastW = view.clientWidth;
  new ResizeObserver(() => { if (Math.abs(view.clientWidth - lastW) > 2) { lastW = view.clientWidth; buildScene(); replay.start(true); render(); } }).observe(view);
}
