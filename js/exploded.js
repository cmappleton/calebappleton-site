/* About: an exploded assembly of the places that shaped Caleb, drawn in the
   same flat-tone 3D as the workcell. Plates stack from the ground up; three
   bolts (the constants) hold them together. Balloons key to the parts list. */
import * as THREE from 'three';
import * as C from './cell3d.js';

const host = document.getElementById('xv');
const range = document.getElementById('xv-range');
const out = document.getElementById('xv-out');
const table = document.querySelector('.plist');

const PLATES = [
  { n: 1, label: 'TEXAS', w: 3.0, d: 2.1, t: 0.24, tone: 0.12 },
  { n: 2, label: 'GEORGIA TECH', w: 2.8, d: 2.0, t: 0.16, tone: 0.04 },
  { n: 3, label: 'BAIN', w: 2.62, d: 1.9, t: 0.14, tone: 0.12 },
  { n: 4, label: 'INNOVATION ENDEAVORS', w: 2.86, d: 1.96, t: 0.18, tone: 0.04 },
  { n: 5, label: 'STARTUP', w: 2.3, d: 1.76, t: 0.12, tone: 0.12 },
  { n: 6, label: 'TUNEIN', w: 2.56, d: 1.84, t: 0.16, tone: 0.04 },
  { n: 7, label: 'BISON', w: 2.44, d: 1.7, t: 0.26, tone: 0.2 }
];
const BOLTS = [{ n: 8, x: -0.86, z: -0.46 }, { n: 9, x: 0.86, z: -0.46 }, { n: 10, x: 0, z: 0.5 }];
const GAP = 0.85, HOLE = 0.11;
const YAW = 0.66, EL = 0.5;

if (host) init();

async function init() {
  try { await document.fonts.load('extra-condensed 800 40px Archivo'); } catch (_) {}
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  host.appendChild(renderer.domElement);
  const overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  overlay.setAttribute('aria-hidden', 'true');
  host.appendChild(overlay);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const dir = new THREE.Vector3(Math.sin(YAW) * Math.cos(EL), Math.sin(EL), Math.cos(YAW) * Math.cos(EL));
  let pen, W, H, plates = [], bolts = [], e = 0;
  const totalT = PLATES.reduce((a, p) => a + p.t, 0);

  function plateGeo(p) {
    const c = 0.22, hw = p.w / 2, hd = p.d / 2;
    const s = new THREE.Shape();
    s.moveTo(-hw + c, -hd); s.lineTo(hw - c, -hd); s.lineTo(hw, -hd + c); s.lineTo(hw, hd - c);
    s.lineTo(hw - c, hd); s.lineTo(-hw + c, hd); s.lineTo(-hw, hd - c); s.lineTo(-hw, -hd + c); s.lineTo(-hw + c, -hd);
    BOLTS.forEach(b => { const h = new THREE.Path(); h.absarc(b.x, -b.z, HOLE, 0, Math.PI * 2, true); s.holes.push(h); });
    const g = new THREE.ExtrudeGeometry(s, { depth: p.t, bevelEnabled: false, curveSegments: 20 });
    g.rotateX(-Math.PI / 2);
    return g;
  }

  function engraving(p) {
    const w = p.w * 0.78, h = 0.26;
    const m = pen.decal(w, h, (c, u, CW, CH) => {
      c.fillStyle = '#1D2766'; c.globalAlpha = 0.75; c.textBaseline = 'middle';
      c.font = `800 ${CH * 0.72}px Archivo, sans-serif`;
      if ('fontStretch' in c) c.fontStretch = 'extra-condensed';
      let size = CH * 0.72;
      while (c.measureText(p.label).width > CW * 0.98 && size > 8) { size -= 2; c.font = `800 ${size}px Archivo, sans-serif`; }
      c.fillText(p.label, 0, CH * 0.55);
    }, 360);
    m.rotation.x = -Math.PI / 2;
    return m;
  }

  function build() {
    W = host.clientWidth; H = host.clientHeight;
    renderer.setSize(W, H, false);
    pen = new C.Pen(renderer, { mode: 'tone' });
    while (scene.children.length) scene.remove(scene.children[0]);
    plates = PLATES.map(p => {
      const g = new THREE.Group();
      const geo = plateGeo(p);
      g.add(pen.solid(geo, p.tone, { threshold: 30 }));
      const label = engraving(p);
      label.position.set(-p.w / 2 + 0.2 + p.w * 0.39, p.t + 0.002, p.d / 2 - 0.26);
      g.add(label);
      scene.add(g);
      return { p, g };
    });
    bolts = BOLTS.map(b => {
      const g = new THREE.Group();
      const shank = pen.solid(new THREE.CylinderGeometry(HOLE * 0.82, HOLE * 0.82, totalT + 0.25, 18), 0.25, { threshold: 40 });
      shank.position.y = -(totalT + 0.25) / 2;
      const head = pen.solid(new THREE.CylinderGeometry(0.19, 0.19, 0.11, 6), 0.35, { threshold: 40 });
      head.position.y = 0.055;
      g.add(shank, head);
      g.position.set(b.x, 0, b.z);
      scene.add(g);
      return { b, g };
    });
    // fit the camera to the fully exploded stack, leaving room for balloons on both sides
    const top = totalT + GAP * 6 + GAP * 1.3 + 0.2;
    const pts = [];
    [[-1.55, 0, -1.1], [1.55, 0, 1.1], [-1.55, top, -1.1], [1.55, top, 1.1], [1.55, 0, -1.1], [-1.55, top, 1.1], [0, -0.3, 0]].forEach(([x, y, z]) => pts.push(new THREE.Vector3(x, y, z)));
    const target = new THREE.Vector3(0, top / 2, 0);
    camera.position.copy(target).addScaledVector(dir, 40);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const inv = camera.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    pts.forEach(v => { const q = v.clone().applyMatrix4(inv); minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); });
    const padX = (maxX - minX) * 0.2, padY = (maxY - minY) * 0.03;
    let hw = (maxX - minX) / 2 + padX, hh = (maxY - minY) / 2 + padY;
    if (hw / hh > W / H) hh = hw * H / W; else hw = hh * W / H;
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    camera.left = cx - hw; camera.right = cx + hw; camera.top = cy + hh; camera.bottom = cy - hh;
    camera.updateProjectionMatrix();
    overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    pose();
  }

  const project = v => { const p = v.clone().project(camera); return [(p.x + 1) / 2 * W, (1 - p.y) / 2 * H]; };

  let hot = null;
  function pose() {
    let y = 0;
    plates.forEach(({ p, g }, i) => { g.position.y = y + e * GAP * i; y += p.t; });
    const stackTop = plates[plates.length - 1].g.position.y + PLATES[PLATES.length - 1].t;
    bolts.forEach(({ g }) => { g.position.y = stackTop + e * GAP * 1.3; });
    renderer.render(scene, camera);
    drawBalloons();
  }

  function drawBalloons() {
    const NS = 'http://www.w3.org/2000/svg';
    let html = '';
    // plates: balloons in a column on the right, spread so they never collide
    const right = plates.map(({ p, g }) => {
      const a = project(new THREE.Vector3(p.w / 2, g.position.y + p.t / 2, 0.2));
      return { n: p.n, ax: a[0], ay: a[1] };
    }).sort((a, b) => a.ay - b.ay);
    const ext = plates.map(({ p, g }) => project(new THREE.Vector3(p.w / 2, g.position.y, -p.d / 2))[0]);
    const colR = Math.min(W - 18, Math.max(...ext) + 34), minGap = 30;
    for (let i = 0; i < right.length; i++) right[i].by = i === 0 ? right[i].ay : Math.max(right[i].ay, right[i - 1].by + minGap);
    const overflow = right[right.length - 1].by - (H - 18);
    if (overflow > 0) right.forEach(r => { r.by -= overflow; });
    // bolts: balloons on the left
    const left = bolts.map(({ b, g }) => { const a = project(new THREE.Vector3(b.x, g.position.y + 0.11, b.z)); return { n: b.n, ax: a[0], ay: a[1] }; }).sort((a, b) => a.ay - b.ay);
    const extL = plates.map(({ p, g }) => project(new THREE.Vector3(-p.w / 2, g.position.y, p.d / 2))[0]);
    const colL = Math.max(18, Math.min(...extL) - 30);
    for (let i = 0; i < left.length; i++) left[i].by = i === 0 ? Math.min(left[i].ay - 40, left[i].ay) : Math.max(left[i].ay - 40, left[i - 1].by + minGap);
    // center lines through the bolts
    bolts.forEach(({ b, g }) => {
      const [x1, y1] = project(new THREE.Vector3(b.x, g.position.y + 0.5, b.z));
      const [x2, y2] = project(new THREE.Vector3(b.x, -0.25, b.z));
      html += `<path d="M ${x1} ${y1} L ${x2} ${y2}" stroke="#A9AFC6" stroke-width="1" stroke-dasharray="14 4 2 4" fill="none"/>`;
    });
    const balloon = (r, cx) => {
      const isHot = hot === r.n;
      const ink = isHot ? '#F0441C' : '#1D2766';
      const edge = cx > W / 2 ? cx - 13 : cx + 13;
      html += `<circle cx="${r.ax}" cy="${r.ay}" r="2.3" fill="${ink}"/>`;
      html += `<path d="M ${r.ax} ${r.ay} L ${edge} ${r.by}" stroke="${ink}" stroke-width="1" fill="none"/>`;
      html += `<circle cx="${cx}" cy="${r.by}" r="13" fill="#E8EAE4" stroke="${ink}" stroke-width="1.5"/>`;
      html += `<text x="${cx}" y="${r.by + 4.5}" text-anchor="middle" font-size="13" fill="${isHot ? '#BF2F0E' : '#1D2766'}" style="font-family:Archivo;font-weight:700;font-stretch:75%">${r.n}</text>`;
    };
    right.forEach(r => balloon(r, colR));
    left.forEach(r => balloon(r, colL));
    overlay.innerHTML = html;
  }

  /* hover: plate under the pointer, or a parts-list row, lights up both */
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
  function setHot(n) {
    if (hot === n) return;
    hot = n;
    if (table) table.querySelectorAll('tr[data-item]').forEach(tr => tr.classList.toggle('is-hot', +tr.dataset.item === n));
    drawBalloons();
  }
  host.addEventListener('pointermove', ev => {
    const r = host.getBoundingClientRect();
    mouse.set(((ev.clientX - r.left) / W) * 2 - 1, -((ev.clientY - r.top) / H) * 2 + 1);
    ray.setFromCamera(mouse, camera);
    const hits = ray.intersectObjects([...plates.map(x => x.g), ...bolts.map(x => x.g)], true);
    if (!hits.length) { setHot(null); return; }
    let o = hits[0].object;
    while (o.parent && o.parent !== scene) o = o.parent;
    const pl = plates.find(x => x.g === o), bo = bolts.find(x => x.g === o);
    setHot(pl ? pl.p.n : bo ? bo.b.n : null);
  });
  host.addEventListener('pointerleave', () => setHot(null));
  if (table) table.querySelectorAll('tr[data-item]').forEach(tr => {
    tr.addEventListener('mouseenter', () => setHot(+tr.dataset.item));
    tr.addEventListener('mouseleave', () => setHot(null));
  });

  function setE(v, fromSlider) {
    e = Math.max(0, Math.min(1, v));
    if (!fromSlider && range) range.value = Math.round(e * 100);
    if (out) out.textContent = Math.round(e * 100) + '%';
    pose();
  }
  if (range) range.addEventListener('input', () => setE(range.value / 100, true));

  build();
  setE(reduce ? 0.7 : 0);
  let played = false;
  new IntersectionObserver(entries => {
    if (played || !entries[0].isIntersecting) return;
    played = true;
    if (reduce) return;
    const t0 = performance.now(), dur = 1400;
    const tick = t => {
      const k = Math.min(1, (t - t0) / dur);
      setE(0.7 * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, { threshold: 0.35 }).observe(host);
  let lastW = W;
  new ResizeObserver(() => { if (Math.abs(host.clientWidth - lastW) > 2) { lastW = host.clientWidth; build(); } }).observe(host);
}
