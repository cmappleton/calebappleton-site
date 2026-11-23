/* About: the places that shaped Caleb, drawn as an espresso machine pulled
   apart. The same parts sit assembled on the homepage shelf. Texas is the
   base, Bison is the cup tray on top, and the side parts are the constants.
   Balloons key to the parts list; hover either one to light up both. */
import * as THREE from 'three';
import * as C from './cell3d.js';

const host = document.getElementById('xv');
const range = document.getElementById('xv-range');
const out = document.getElementById('xv-out');
const table = document.querySelector('.plist');

const YAW = 0.66, EL = 0.5;

if (host) init();

async function init() {
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
  let pen, W, H, parts = [], e = 0;

  const corners = b => {
    const v = [];
    for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) v.push(new THREE.Vector3(x, y, z));
    return v;
  };

  function build() {
    W = host.clientWidth; H = host.clientHeight;
    renderer.setSize(W, H, false);
    pen = new C.Pen(renderer, { mode: 'tone' });
    while (scene.children.length) scene.remove(scene.children[0]);
    parts = C.espressoParts(pen);
    parts.forEach(p => {
      scene.add(p.group);
      p.group.updateMatrixWorld(true);
      p.center = new THREE.Box3().setFromObject(p.group).getCenter(new THREE.Vector3());
    });

    // fit the camera to the fully exploded machine, leaving room for balloons on both sides
    const box = new THREE.Box3();
    parts.forEach(p => { p.group.position.copy(p.explode); p.group.updateMatrixWorld(true); box.expandByObject(p.group); });
    box.expandByPoint(new THREE.Vector3(0, -0.15, 0));
    const target = box.getCenter(new THREE.Vector3());
    camera.position.copy(target).addScaledVector(dir, 40);
    camera.lookAt(target);
    camera.updateMatrixWorld();
    const inv = camera.matrixWorldInverse;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    corners(box).forEach(v => { const q = v.applyMatrix4(inv); minX = Math.min(minX, q.x); maxX = Math.max(maxX, q.x); minY = Math.min(minY, q.y); maxY = Math.max(maxY, q.y); });
    const padX = (maxX - minX) * 0.2, padY = (maxY - minY) * 0.04;
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
    parts.forEach(p => p.group.position.copy(p.explode).multiplyScalar(e));
    renderer.render(scene, camera);
    drawBalloons();
  }

  function drawBalloons() {
    let html = '';
    // dash-dot assembly lines: the stack's axis, and the path each side part travels
    const trayLift = (parts.find(p => p.key === 'tray') || { explode: { y: 0 } }).explode.y;
    const axisTop = project(new THREE.Vector3(0, 0.95 + trayLift * e + 0.3, -0.075));
    const axisBot = project(new THREE.Vector3(0, -0.15, -0.075));
    const line = (a, b) => `<path d="M ${a[0]} ${a[1]} L ${b[0]} ${b[1]}" stroke="#A9AFC6" stroke-width="1" stroke-dasharray="14 4 2 4" fill="none"/>`;
    html += line(axisTop, axisBot);
    if (e > 0.02) parts.filter(p => p.side === 'left' || p.key === 'wand').forEach(p => {
      const home = p.center.clone().add(p.explode.clone().setX(0).setZ(0).multiplyScalar(e));
      html += line(project(home), project(p.center.clone().add(p.explode.clone().multiplyScalar(e))));
    });

    // where everything is right now, for the balloon columns
    const now = new THREE.Box3();
    parts.forEach(p => { p.group.updateMatrixWorld(true); now.expandByObject(p.group); });
    const xs = corners(now).map(v => project(v)[0]);
    const colR = Math.min(W - 18, Math.max(...xs) + 34), colL = Math.max(18, Math.min(...xs) - 34);
    const minGap = 30;
    const column = side => {
      const list = parts.filter(p => p.side === side).map(p => {
        const a = project(p.anchor.clone().add(p.group.position));
        return { n: p.n, ax: a[0], ay: a[1] };
      }).sort((a, b) => a.ay - b.ay);
      for (let i = 0; i < list.length; i++) list[i].by = i === 0 ? Math.max(18, list[i].ay) : Math.max(list[i].ay, list[i - 1].by + minGap);
      const overflow = list.length ? list[list.length - 1].by - (H - 18) : 0;
      if (overflow > 0) list.forEach(r => { r.by -= overflow; });
      return list;
    };
    const balloon = (r, cx) => {
      const isHot = hot === r.n;
      const ink = isHot ? '#F0441C' : '#1D2766';
      const edge = cx > W / 2 ? cx - 13 : cx + 13;
      html += `<circle cx="${r.ax}" cy="${r.ay}" r="2.3" fill="${ink}"/>`;
      html += `<path d="M ${r.ax} ${r.ay} L ${edge} ${r.by}" stroke="${ink}" stroke-width="1" fill="none"/>`;
      html += `<circle cx="${cx}" cy="${r.by}" r="13" fill="#E8EAE4" stroke="${ink}" stroke-width="1.5"/>`;
      html += `<text x="${cx}" y="${r.by + 4.5}" text-anchor="middle" font-size="13" fill="${isHot ? '#BF2F0E' : '#1D2766'}" style="font-family:Archivo;font-weight:700;font-stretch:75%">${r.n}</text>`;
    };
    column('right').forEach(r => balloon(r, colR));
    column('left').forEach(r => balloon(r, colL));
    overlay.innerHTML = html;
  }

  /* hover: the part under the pointer, or a parts-list row, lights up both */
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
    const hits = ray.intersectObjects(parts.map(p => p.group), true);
    if (!hits.length) { setHot(null); return; }
    let o = hits[0].object;
    while (o.parent && o.parent !== scene) o = o.parent;
    const p = parts.find(x => x.group === o);
    setHot(p ? p.n : null);
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
