/* The workcell in 3D, drawn like a patent figure: real geometry and light,
   rendered as ink outlines, crease lines and hatching on drafting film.
   Builders return groups with the origin at the bottom center, x to the
   right (objects face left), y up, z toward the viewer. One unit is about
   the height of the cortado glass. */
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

export const FILM_HEX = 0xE8EAE4;
export const INK_HEX = 0x1D2766;
const FILM = new THREE.Vector3(232 / 255, 234 / 255, 228 / 255);
const INK = new THREE.Vector3(29 / 255, 39 / 255, 102 / 255);
const V2 = (x, y) => new THREE.Vector2(x, y);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

/* ---------- drawing context: materials that depend on canvas size ---------- */
export class Pen {
  constructor(renderer, opts = {}) {
    this.renderer = renderer;
    this.linePx = opts.linePx || 1.25;
    this.hullPx = opts.hullPx || 1.6;
    this.mode = opts.mode || 'hatch';   // 'hatch' | 'light' | 'tone'
    this.spacing = opts.spacing || (this.mode === 'light' ? 7 : 5);
    this.lineW = opts.lineW || (this.mode === 'light' ? 0.3 : 0.42);
    this.hatchCache = new Map();
    this.lineMats = [];
    this.hullMat = this._hullMaterial();
    this.glassMat = this._glassMaterial();
    this.resize();
  }

  resize() {
    const s = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(s);
    const dpr = this.renderer.getPixelRatio();
    this.hullMat.uniforms.uRes.value.set(s.x, s.y);
    this.hullMat.uniforms.uPx.value = this.hullPx * dpr;
    this.hatchCache.forEach(m => { m.uniforms.uDpr.value = dpr; });
    this.lineMats.forEach(m => m.resolution.set(s.x / dpr, s.y / dpr));
  }

  /* tone: 0 = lit paper, 1 = darkest. Negative brightens (paper that should stay clean). */
  hatch(tone) {
    const key = tone.toFixed(3);
    if (this.hatchCache.has(key)) return this.hatchCache.get(key);
    const m = new THREE.ShaderMaterial({
      uniforms: { uInk: { value: INK }, uFilm: { value: FILM }, uTone: { value: tone }, uDpr: { value: this.renderer.getPixelRatio() }, uS: { value: this.spacing }, uW: { value: this.lineW } },
      vertexShader: /* glsl */`
        varying vec3 vN;
        void main() {
          vN = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uInk; uniform vec3 uFilm; uniform float uTone; uniform float uDpr; uniform float uS; uniform float uW;
        varying vec3 vN;
        float lineAt(float c, float s) {
          float d = abs(fract(c / s) - 0.5) * s;
          return 1.0 - smoothstep(uW, uW + 0.8, d);
        }
        void main() {
          vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
          float d = max(dot(n, normalize(vec3(-0.45, 0.85, 0.55))), 0.0);
          float I = (0.42 + 0.58 * d) * (1.0 - uTone) + 0.06;
          vec2 p = gl_FragCoord.xy / uDpr;
          float ink = 0.0;
          ${this.mode === 'tone' ? `
          ink = I > 0.72 ? 0.0 : (I > 0.5 ? 0.13 : (I > 0.3 ? 0.3 : 0.52));
          ` : this.mode === 'light' ? `
          if (I < 0.58) ink = max(ink, lineAt(p.x + p.y, uS) * 0.85);
          if (I < 0.32) ink = max(ink, lineAt(p.x - p.y, uS) * 0.85);
          ` : `
          if (I < 0.7)  ink = max(ink, lineAt(p.x + p.y, uS));
          if (I < 0.45) ink = max(ink, lineAt(p.x - p.y, uS));
          if (I < 0.25) ink = max(ink, lineAt(p.x, uS * 0.68));
          `}
          gl_FragColor = vec4(mix(uFilm, uInk, ink), 1.0);
        }`,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1
    });
    this.hatchCache.set(key, m);
    return m;
  }

  _hullMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uInk: { value: INK }, uPx: { value: 2 }, uRes: { value: new THREE.Vector2(1, 1) } },
      vertexShader: /* glsl */`
        uniform float uPx; uniform vec2 uRes;
        void main() {
          vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          vec3 nv = normalize(normalMatrix * normal);
          vec2 dir = (projectionMatrix * vec4(nv, 0.0)).xy;
          float len = length(dir);
          if (len > 1e-5) clip.xy += (dir / len) * uPx * 2.0 / uRes * clip.w;
          gl_Position = clip;
        }`,
      fragmentShader: /* glsl */`uniform vec3 uInk; void main() { gl_FragColor = vec4(uInk, 1.0); }`,
      side: THREE.BackSide
    });
  }

  _glassMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: { uInk: { value: INK } },
      vertexShader: /* glsl */`
        varying vec3 vN; varying vec3 vV;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uInk; varying vec3 vN; varying vec3 vV;
        void main() {
          vec3 n = normalize(vN); if (!gl_FrontFacing) n = -n;
          float f = 1.0 - abs(dot(n, normalize(vV)));
          gl_FragColor = vec4(uInk, smoothstep(0.5, 0.95, f));
        }`,
      transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
  }

  lineMaterial() {
    const m = new LineMaterial({ color: INK_HEX, linewidth: this.linePx, worldUnits: false });
    this.lineMats.push(m);
    const s = new THREE.Vector2();
    this.renderer.getDrawingBufferSize(s);
    const dpr = this.renderer.getPixelRatio();
    m.resolution.set(s.x / dpr, s.y / dpr);
    return m;
  }

  /* A hatched solid with a silhouette outline and crease lines. Returns a group. */
  solid(geo, tone, o = {}) {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(geo, this.hatch(tone)));
    if (o.hull !== false) {
      const hg = mergeVertices(geo.clone().deleteAttribute('normal').deleteAttribute('uv'), 1e-4);
      hg.computeVertexNormals();
      g.add(new THREE.Mesh(hg, this.hullMat));
    }
    if (o.edges !== false) g.add(this.edges(geo, o.threshold || 35));
    return g;
  }

  edges(geo, threshold) {
    const lg = new LineSegmentsGeometry().fromEdgesGeometry(new THREE.EdgesGeometry(geo, threshold));
    return new LineSegments2(lg, this.lineMaterial());
  }

  polyline(points) {
    const pos = [];
    for (let i = 0; i < points.length - 1; i++) pos.push(...points[i].toArray(), ...points[i + 1].toArray());
    const lg = new LineSegmentsGeometry().setPositions(pos);
    return new LineSegments2(lg, this.lineMaterial());
  }

  /* Printed artwork on a flat face, drawn with a 2D canvas in ink. */
  decal(w, h, draw, ppu = 220) {
    const c = document.createElement('canvas');
    c.width = Math.round(w * ppu); c.height = Math.round(h * ppu);
    const g = c.getContext('2d');
    draw(g, ppu, c.width, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const m = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    return new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
  }
}

const INK_CSS = '#1D2766', FILM_CSS = '#E8EAE4';
function font(g, weight, px, stretch) {
  g.font = `${weight} ${px}px Archivo, sans-serif`;
  if ('fontStretch' in g) g.fontStretch = stretch || 'extra-condensed';
}

/* ---------- objects ---------- */
const lathe = (pts, seg = 96) => new THREE.LatheGeometry(pts.map(([x, y]) => V2(x, y)), seg);

export function cortado(pen) {
  const R0 = 0.385, R1 = 0.5, HH = 0.98, WALL = 0.035, BASE = 0.13;
  const rOut = y => R0 + (R1 - R0) * (y / HH);
  const rIn = y => rOut(y) - WALL;
  const glassGeo = lathe([[0, 0], [R0 - 0.02, 0], [R0, 0.02], [rOut(HH), HH], [rOut(HH) - 0.008, HH + 0.012], [rIn(HH) + 0.006, HH + 0.012], [rIn(HH), HH], [rIn(BASE), BASE], [0, BASE]]);
  const g = new THREE.Group();
  const layer = (y0, y1) => lathe([[0, y0], [rIn(y0) - 0.004, y0], [rIn(y1) - 0.004, y1], [0, y1]]);
  g.add(pen.solid(layer(BASE + 0.002, 0.6), 0.72, { edges: false }));
  g.add(pen.solid(layer(0.6, 0.73), 0.3, { hull: false, threshold: 50 }));
  g.add(pen.solid(layer(0.73, 0.745), 0.0, { hull: false, threshold: 50 }));
  const glass = new THREE.Mesh(glassGeo, pen.glassMat);
  glass.renderOrder = 2;
  g.add(glass, pen.edges(glassGeo, 40));
  return { group: g, anchor: V3(0.48, 0.82, 0), size: [1.0, 1.0] };
}

function bisonShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.5, 0);
  s.lineTo(-0.41, 0); s.lineTo(-0.4, 0.27); s.lineTo(-0.33, 0.27);
  s.lineTo(-0.32, 0); s.lineTo(-0.23, 0); s.lineTo(-0.22, 0.31);
  s.splineThru([V2(0.0, 0.35), V2(0.25, 0.37), V2(0.4, 0.37)]);
  s.lineTo(0.42, 0.2); s.lineTo(0.41, 0); s.lineTo(0.5, 0); s.lineTo(0.51, 0.18);
  s.lineTo(0.54, 0.29); s.lineTo(0.57, 0.18); s.lineTo(0.56, 0); s.lineTo(0.65, 0); s.lineTo(0.66, 0.2);
  s.splineThru([V2(0.7, 0.36), V2(0.74, 0.52)]);
  s.lineTo(0.77, 0.55); s.lineTo(0.8, 0.42); s.lineTo(0.84, 0.33); s.lineTo(0.8, 0.32); s.lineTo(0.76, 0.42); s.lineTo(0.745, 0.58);
  s.splineThru([V2(0.72, 0.66), V2(0.5, 0.71), V2(0.2, 0.8), V2(-0.05, 0.94), V2(-0.25, 1.0), V2(-0.42, 0.95), V2(-0.55, 0.8)]);
  s.lineTo(-0.6, 0.72);
  s.quadraticCurveTo(-0.68, 0.74, -0.7, 0.85);
  s.quadraticCurveTo(-0.74, 0.75, -0.66, 0.67);
  s.splineThru([V2(-0.75, 0.6), V2(-0.83, 0.48), V2(-0.86, 0.36)]);
  s.splineThru([V2(-0.83, 0.3), V2(-0.76, 0.27)]);
  s.splineThru([V2(-0.73, 0.2), V2(-0.66, 0.15), V2(-0.6, 0.22)]);
  s.splineThru([V2(-0.55, 0.27), V2(-0.51, 0.22)]);
  s.lineTo(-0.5, 0);
  return s;
}

function maneShape() {
  const s = new THREE.Shape();
  s.moveTo(-0.06, 0.9);
  s.splineThru([V2(-0.25, 0.97), V2(-0.41, 0.92), V2(-0.53, 0.78)]);
  s.splineThru([V2(-0.6, 0.62), V2(-0.63, 0.42), V2(-0.62, 0.22)]);
  s.splineThru([V2(-0.52, 0.25), V2(-0.43, 0.2), V2(-0.31, 0.22)]);
  s.splineThru([V2(-0.18, 0.4), V2(-0.08, 0.62), V2(-0.06, 0.9)]);
  return s;
}

export function bison(pen) {
  const g = new THREE.Group();
  const ex = (shape, depth, bevel) => {
    const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.7, bevelSegments: 3, curveSegments: 20 });
    geo.translate(0, bevel * 0.7, -depth / 2);
    return geo;
  };
  g.add(pen.solid(ex(bisonShape(), 0.24, 0.05), 0.3, { threshold: 55 }));
  g.add(pen.solid(ex(maneShape(), 0.3, 0.04), 0.58, { threshold: 55 }));
  [-1, 1].forEach(sz => {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.025, 16, 12), pen.hatch(1));
    eye.position.set(-0.73, 0.52, sz * 0.165);
    g.add(eye);
  });
  return { group: g, anchor: V3(-0.22, 0.98, 0.15), size: [1.7, 1.0] };
}

export function book(pen, label, depth) {
  const L = 2.3, T = 0.5, D = depth || 1.5;
  const g = new THREE.Group();
  const board = new RoundedBoxGeometry(L, 0.07, D, 2, 0.012);
  const top = pen.solid(board, 0.25); top.position.set(0, T - 0.035, 0);
  const bot = pen.solid(board, 0.25); bot.position.set(0, 0.035, 0);
  const pages = pen.solid(new THREE.BoxGeometry(L - 0.08, T - 0.14, D - 0.08), -0.3); pages.position.set(0, T / 2, -0.04);
  const spineGeo = new THREE.CylinderGeometry(T / 2, T / 2, L, 40, 1, true, -Math.PI / 2, Math.PI);
  spineGeo.rotateZ(Math.PI / 2);
  spineGeo.scale(1, 1, 0.32);
  const spine = pen.solid(spineGeo, 0.62, { threshold: 60 }); spine.position.set(0, T / 2, D / 2);
  g.add(top, bot, pages, spine);
  const lab = pen.decal(L * 0.84, T * 0.62, (c, u, W, H) => {
    c.fillStyle = FILM_CSS; c.strokeStyle = INK_CSS; c.lineWidth = Math.max(2, u * 0.012);
    c.fillRect(0, 0, W, H); c.strokeRect(c.lineWidth / 2, c.lineWidth / 2, W - c.lineWidth, H - c.lineWidth);
    c.fillStyle = INK_CSS; c.textBaseline = 'middle';
    font(c, 800, H * 0.62); c.fillText(label, H * 0.3, H * 0.54);
    font(c, 650, H * 0.26, 'condensed'); c.textAlign = 'right'; c.fillText('C. Appleton', W - H * 0.3, H * 0.55);
  });
  lab.position.set(0, T / 2, D / 2 + T / 2 * 0.32 + 0.004);
  g.add(lab);
  return { group: g, anchor: null, size: [L, T] };
}

export function helmet(pen, opts = {}) {
  const g = new THREE.Group();
  const deform = (x, y, z) => V3(
    x * 0.75 + (x > 0 ? x * x * 0.14 * (1 - y) : 0),
    y * 0.56 + 0.07,
    z * 0.56
  );
  const shell = new THREE.SphereGeometry(1, 72, 28, 0, Math.PI * 2, 0, Math.PI / 2);
  const p = shell.attributes.position;
  for (let i = 0; i < p.count; i++) { const v = deform(p.getX(i), p.getY(i), p.getZ(i)); p.setXYZ(i, v.x, v.y, v.z); }
  shell.computeVertexNormals();
  g.add(pen.solid(shell, 0.42, { threshold: 70 }));
  // foam liner band under the rim
  const ell = (rx, rz) => { const s = new THREE.Path(); s.absellipse(0, 0, rx, rz, 0, Math.PI * 2, false); return s; };
  const ring = new THREE.Shape(); ring.absellipse(0.03, 0, 0.8, 0.565, 0, Math.PI * 2, false);
  ring.holes.push(ell(0.7, 0.48));
  const band = new THREE.ExtrudeGeometry(ring, { depth: 0.07, bevelEnabled: false, curveSegments: 48 });
  band.rotateX(Math.PI / 2); band.translate(0, 0.07, 0);
  g.add(pen.solid(band, -0.2, { threshold: 50 }));
  // vents cut along the shell, front to back
  const surf = (x, z) => {
    const y = Math.sqrt(Math.max(0, 1 - x * x - z * z));
    const v = deform(x, y, z);
    const n = v.clone().sub(V3(0, 0.07, 0)).normalize();
    return v.add(n.multiplyScalar(0.006));
  };
  [[0, -0.66, 0.5, 0.08], [0.31, -0.58, 0.42, 0.07], [-0.31, -0.58, 0.42, 0.07], [0.6, -0.42, 0.24, 0.06], [-0.6, -0.42, 0.24, 0.06]].forEach(([z0, x1, x2, w]) => {
    const nx = 14, nz = 3, verts = [], idx = [];
    for (let i = 0; i <= nx; i++) {
      const t = i / nx, x = x1 + (x2 - x1) * t, taper = Math.pow(Math.sin(Math.PI * t), 0.6);
      for (let j = 0; j <= nz; j++) { const z = z0 + (j / nz * 2 - 1) * w * taper; verts.push(...surf(x, z).toArray()); }
    }
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const a = i * (nz + 1) + j, b = a + nz + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    const m = new THREE.Mesh(geo, pen.hatch(0.95));
    m.material = m.material.clone(); m.material.polygonOffsetFactor = -2; m.material.polygonOffsetUnits = -2;
    g.add(m, pen.edges(geo, 89));
  });
  // straps and buckle
  (opts.frontStraps ? [1] : [1, -1]).forEach(sz => {
    const zf = opts.frontStraps ? 0.64 : 0.5 * sz;
    const pts = opts.frontStraps
      ? [[V3(-0.6, 0.06, 0.42), V3(-0.4, -0.1, 0.62), V3(-0.2, -0.26, zf)], [V3(0.52, 0.06, 0.45), V3(0.15, -0.12, 0.64), V3(-0.18, -0.27, zf)], [V3(-0.19, -0.27, zf), V3(-0.24, -0.38, zf), V3(-0.26, -0.44, zf)]]
      : [[V3(-0.6, 0.06, 0.42 * sz), V3(-0.38, -0.12, 0.5 * sz), V3(-0.2, -0.26, 0.5 * sz)], [V3(0.52, 0.06, 0.45 * sz), V3(0.15, -0.14, 0.52 * sz), V3(-0.18, -0.27, 0.5 * sz)], [V3(-0.19, -0.27, 0.5 * sz), V3(-0.24, -0.38, 0.3 * sz), V3(-0.26, -0.44, 0.06 * sz)]];
    pts.forEach(c => g.add(pen.solid(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(c), 24, 0.018, 8), 0.9, { edges: false })));
    const slider = pen.solid(new RoundedBoxGeometry(0.1, 0.07, 0.04, 2, 0.01), 0.6); slider.position.set(-0.19, -0.27, zf); g.add(slider);
  });
  const buckle = pen.solid(new RoundedBoxGeometry(0.16, 0.09, 0.11, 2, 0.015), 0.65); buckle.position.set(-0.26, -0.46, opts.frontStraps ? 0.64 : 0); g.add(buckle);
  const dial = pen.solid(new THREE.CylinderGeometry(0.06, 0.06, 0.05, 20).rotateZ(Math.PI / 2), 0.7); dial.position.set(0.86, 0.06, 0); g.add(dial);
  return { group: g, anchor: V3(0.42, 0.5, 0.3), size: [1.75, 0.63] };
}

export function walker(pen) {
  const g = new THREE.Group();
  const at = (obj, x, y, z) => { obj.position.set(x, y, z); g.add(obj); return obj; };
  const capsule = (a, b, r, tone) => {
    const len = a.distanceTo(b);
    const geo = new THREE.CapsuleGeometry(r, len, 4, 12);
    const m = pen.solid(geo, tone, { edges: false });
    m.position.copy(a).lerp(b, 0.5);
    m.quaternion.setFromUnitVectors(V3(0, 1, 0), b.clone().sub(a).normalize());
    g.add(m);
  };
  const leg = (hx, dir, z) => {
    const hip = V3(hx, 0.36, z), knee = V3(hx + dir * 0.2, 0.17, z), foot = V3(hx - dir * 0.05, 0.05, z);
    capsule(hip, knee, 0.052, 0.12);
    capsule(knee, foot, 0.032, 0.88);
    at(pen.solid(new THREE.CylinderGeometry(0.058, 0.058, 0.07, 20).rotateX(Math.PI / 2), 0.7), knee.x, knee.y, z);
    at(pen.solid(new THREE.SphereGeometry(0.05, 16, 12), 0.85, { edges: false }), foot.x, foot.y, z);
    at(pen.solid(new THREE.CylinderGeometry(0.09, 0.09, 0.09, 24).rotateX(Math.PI / 2), 0.2), hip.x, hip.y, z);
  };
  leg(-0.36, -1, -0.3); leg(0.36, 1, -0.3);
  at(pen.solid(new RoundedBoxGeometry(1.0, 0.32, 0.5, 3, 0.05), 0.58), 0, 0.5, 0);
  at(pen.solid(new THREE.BoxGeometry(0.8, 0.17, 0.02), 0.1), 0, 0.5, 0.255);
  const slots = pen.decal(0.34, 0.11, (c, u, W, H) => {
    c.fillStyle = INK_CSS;
    for (let i = 0; i < 6; i++) { const x = i * W / 6 + W * 0.03; c.beginPath(); c.roundRect(x, H * 0.1, W * 0.1, H * 0.8, W * 0.04); c.fill(); }
  });
  at(slots, -0.18, 0.5, 0.268);
  at(pen.solid(new RoundedBoxGeometry(0.18, 0.24, 0.34, 3, 0.04), 0.62), -0.58, 0.5, 0);
  [0.08, -0.08].forEach(z => at(pen.solid(new THREE.CylinderGeometry(0.042, 0.042, 0.03, 20).rotateZ(Math.PI / 2), 1), -0.676, 0.54, z));
  const handle = pen.solid(new THREE.TorusGeometry(0.11, 0.022, 10, 28, Math.PI), 0.85, { threshold: 70 });
  at(handle, 0.3, 0.66, 0);
  leg(-0.36, -1, 0.3); leg(0.36, 1, 0.3);
  return { group: g, anchor: V3(0.3, 0.78, 0), size: [1.4, 0.8] };
}

export function envelope(pen, label) {
  const W = 1.5, H = 1.0, Dz = 0.03;
  const g = new THREE.Group();
  const body = pen.solid(new RoundedBoxGeometry(W, H, Dz, 1, 0.006), -0.4); body.position.set(0, H / 2, 0);
  const art = pen.decal(W, H, (c, u, CW, CH) => {
    const px = v => v * u;
    c.strokeStyle = INK_CSS; c.fillStyle = INK_CSS; c.lineCap = 'round';
    c.globalAlpha = 0.35; c.lineWidth = px(0.008);
    c.beginPath(); c.moveTo(px(0.02), CH - px(0.02)); c.lineTo(px(0.62), px(0.52)); c.moveTo(CW - px(0.02), CH - px(0.02)); c.lineTo(CW - px(0.62), px(0.52)); c.stroke();
    c.globalAlpha = 1;
    // stamp
    const sx = CW - px(0.36), sy = px(0.08), sw = px(0.26), sh = px(0.3);
    c.lineWidth = px(0.006); c.setLineDash([px(0.012), px(0.01)]); c.strokeRect(sx, sy, sw, sh); c.setLineDash([]);
    c.lineWidth = px(0.005); c.strokeRect(sx + px(0.025), sy + px(0.025), sw - px(0.05), sh - px(0.05));
    c.lineWidth = px(0.008);
    c.beginPath(); c.arc(sx + sw / 2, sy + sh * 0.42, px(0.055), 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.moveTo(sx + sw * 0.25, sy + sh * 0.72); c.lineTo(sx + sw * 0.75, sy + sh * 0.72); c.stroke();
    // postmark
    c.globalAlpha = 0.6; c.lineWidth = px(0.007);
    c.beginPath(); c.arc(sx - px(0.12), sy + px(0.16), px(0.11), 0, Math.PI * 2); c.stroke();
    for (let k = 0; k < 3; k++) {
      c.beginPath();
      for (let x = 0; x <= px(0.36); x += px(0.01)) { const y = sy + px(0.1 + k * 0.06) + Math.sin(x / px(0.03)) * px(0.008); x === 0 ? c.moveTo(sx - px(0.6) + x, y) : c.lineTo(sx - px(0.6) + x, y); }
      c.stroke();
    }
    c.globalAlpha = 1;
    // address
    font(c, 800, px(0.24)); c.textBaseline = 'alphabetic'; c.fillText(label, px(0.16), CH - px(0.3));
    c.fillRect(px(0.16), CH - px(0.22), px(0.62), px(0.018));
    c.fillRect(px(0.16), CH - px(0.15), px(0.42), px(0.018));
  });
  art.position.set(0, H / 2, Dz / 2 + 0.002);
  g.add(body, art);
  return { group: g, anchor: null, size: [W, H] };
}

export function apple(pen) {
  const g = new THREE.Group();
  const wheels = [];
  const deck = new THREE.Shape();
  deck.moveTo(-0.5, 0.16); deck.lineTo(0.5, 0.16);
  deck.quadraticCurveTo(0.58, 0.16, 0.62, 0.23); deck.lineTo(0.6, 0.245);
  deck.quadraticCurveTo(0.56, 0.195, 0.5, 0.195); deck.lineTo(-0.5, 0.195);
  deck.quadraticCurveTo(-0.56, 0.195, -0.6, 0.245); deck.lineTo(-0.62, 0.23);
  deck.quadraticCurveTo(-0.58, 0.16, -0.5, 0.16);
  const dg = new THREE.ExtrudeGeometry(deck, { depth: 0.26, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.008, bevelSegments: 2, curveSegments: 12 });
  dg.translate(0, 0, -0.13);
  g.add(pen.solid(dg, 0.72, { threshold: 50 }));
  [-0.36, 0.36].forEach(x => {
    const truck = pen.solid(new THREE.BoxGeometry(0.1, 0.05, 0.2), 0.15); truck.position.set(x, 0.13, 0); g.add(truck);
    [-0.12, 0.12].forEach(z => {
      const w = new THREE.Group();
      w.add(pen.solid(new THREE.CylinderGeometry(0.065, 0.065, 0.05, 24).rotateX(Math.PI / 2), 0.05));
      const mark = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.07, 0.006), pen.hatch(0.9)); mark.position.set(0, 0.0, 0.028); w.add(mark);
      w.position.set(x, 0.065, z); g.add(w); wheels.push(w);
    });
  });
  const prof = [[0, 0.0], [0.12, 0.0], [0.26, 0.05], [0.36, 0.17], [0.4, 0.33], [0.37, 0.49], [0.28, 0.61], [0.14, 0.65], [0.05, 0.6], [0, 0.585]];
  const body = pen.solid(lathe(prof, 64), 0.2, { edges: false });
  body.position.y = 0.19; g.add(body);
  const stem = pen.solid(new THREE.CylinderGeometry(0.016, 0.02, 0.14, 10), 0.8, { edges: false });
  stem.position.set(0.01, 0.84, 0); stem.rotation.z = -0.25; g.add(stem);
  const leaf = pen.solid(new THREE.SphereGeometry(1, 16, 10).scale(0.12, 0.018, 0.055), 0.35, { edges: false });
  leaf.position.set(0.11, 0.86, 0.02); leaf.rotation.z = 0.35; g.add(leaf);
  const r = y => { for (let i = 1; i < prof.length; i++) if (prof[i][1] >= y) { const [x0, y0] = prof[i - 1], [x1, y1] = prof[i]; return x0 + (x1 - x0) * (y - y0) / (y1 - y0); } return 0; };
  [-0.1, 0.1].forEach(x => {
    const y = 0.36, z = Math.sqrt(Math.max(0, r(y) ** 2 - x * x));
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.032, 14, 10), pen.hatch(1)); eye.position.set(x, 0.19 + y, z - 0.01); g.add(eye);
  });
  const smile = [];
  for (let i = 0; i <= 12; i++) { const x = -0.1 + 0.2 * i / 12, y = 0.24 - 0.045 * (1 - (x / 0.1) ** 2); smile.push(V3(x, 0.19 + y, Math.sqrt(Math.max(0, r(y) ** 2 - x * x)) - 0.004)); }
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(smile), 24, 0.011, 6), pen.hatch(1)));
  return { group: g, anchor: null, size: [1.24, 0.9], wheels };
}

export function shelf(pen, length, depth = 1.15) {
  const g = new THREE.Group();
  const board = pen.solid(new RoundedBoxGeometry(length, 0.06, depth, 2, 0.01), 0.1); board.position.set(0, -0.03, 0);
  g.add(board);
  [-length / 2 + 0.25, length / 2 - 0.25].forEach(x => {
    const a = pen.solid(new THREE.BoxGeometry(0.05, 0.36, 0.05), 0.35); a.position.set(x, -0.24, -depth / 2 + 0.06);
    const b = pen.solid(new THREE.BoxGeometry(0.05, 0.05, depth * 0.7), 0.35); b.position.set(x, -0.085, -depth * 0.12);
    g.add(a, b);
  });
  return g;
}

/* ---------- robot arm ---------- */
function plateShape(L, t, slots) {
  const r = t / 2, s = new THREE.Shape();
  s.moveTo(0, -r); s.lineTo(L, -r); s.absarc(L, 0, r, -Math.PI / 2, Math.PI / 2, false);
  s.lineTo(0, r); s.absarc(0, 0, r, Math.PI / 2, Math.PI * 1.5, false);
  slots.forEach(([a, b]) => {
    const h = new THREE.Path(), sr = t * 0.15;
    h.moveTo(L * a, -sr); h.lineTo(L * b, -sr); h.absarc(L * b, 0, sr, -Math.PI / 2, Math.PI / 2, false);
    h.lineTo(L * a, sr); h.absarc(L * a, 0, sr, Math.PI / 2, Math.PI * 1.5, false);
    s.holes.push(h);
  });
  return s;
}

/* p: { baseW, baseH, turretH, L1, L2, t1, t2, wristH, palmH, fingerLen, fingerW, maxOpen } */
export function arm(pen, p) {
  const root = new THREE.Group();
  const add = (parent, obj, x, y, z) => { obj.position.set(x || 0, y || 0, z || 0); parent.add(obj); return obj; };
  const box = (w, h, d, tone, r) => pen.solid(new RoundedBoxGeometry(w, h, d, 2, r == null ? Math.min(w, h, d) * 0.12 : r), tone);
  const cyl = (rad, h, tone) => pen.solid(new THREE.CylinderGeometry(rad, rad, h, 28).rotateX(Math.PI / 2), tone);
  const t1 = p.t1, t2 = p.t2, gap1 = t1 * 0.62, gap2 = t2 * 0.6, pl = Math.max(0.03, t1 * 0.08);

  add(root, box(p.baseW, p.baseH, p.baseW * 0.85, 0.55), 0, p.baseH / 2, 0);
  const tur = pen.solid(new THREE.CylinderGeometry(t1 * 0.8, p.baseW * 0.36, p.turretH, 4, 1).rotateY(Math.PI / 4), 0.62, { threshold: 30 });
  add(root, tur, 0, p.baseH + p.turretH / 2, 0);
  const shoulder = V3(0, p.baseH + p.turretH, 0);
  add(root, box(t1 * 2.0, t1 * 1.2, gap1 * 2 - pl, 0.66), shoulder.x, shoulder.y, 0);

  const plates = (parent, L, t, gap, slots) => {
    const geo = new THREE.ExtrudeGeometry(plateShape(L, t, slots), { depth: pl, bevelEnabled: false, curveSegments: 24 });
    [1, -1].forEach(sz => add(parent, pen.solid(geo, 0.14, { threshold: 30 }), 0, 0, sz > 0 ? gap : -gap - pl));
  };
  const caps = (parent, r, gap) => [1, -1].forEach(sz => add(parent, cyl(r, pl * 1.6, 0.72), 0, 0, sz * (gap + pl * 1.3)));
  const cable = (parent, L, t) => {
    const c = new THREE.CatmullRomCurve3([V3(-t * 0.1, t * 0.4, 0), V3(L * 0.25, t * 1.3, 0), V3(L * 0.7, t * 1.2, 0), V3(L - t * 0.5, t * 0.45, 0)]);
    add(parent, pen.solid(new THREE.TubeGeometry(c, 32, t * 0.07, 8), 0.9, { edges: false }));
  };

  const gL1 = add(root, new THREE.Group(), shoulder.x, shoulder.y, 0);
  cable(gL1, p.L1, t1);
  plates(gL1, p.L1, t1, gap1, [[0.2, 0.47], [0.55, 0.81]]);
  caps(gL1, t1 * 0.58, gap1);

  const gL2 = add(gL1, new THREE.Group(), p.L1, 0, 0);
  add(gL2, box(t1 * 1.3, t1 * 1.2, gap1 * 2 - pl, 0.66), 0, 0, 0);
  cable(gL2, p.L2, t2);
  plates(gL2, p.L2, t2, gap2, [[0.24, 0.74]]);
  caps(gL2, t1 * 0.48, gap1);

  const gW = add(gL2, new THREE.Group(), p.L2, 0, 0);
  add(gW, box(p.wristH + t2 * 0.5, t2 * 1.2, gap2 * 2, 0.66), (p.wristH - t2 * 0.5) / 2, 0, 0);
  caps(gW, t2 * 0.4, gap2);
  const palmW = p.maxOpen + 2 * p.fingerW + 0.04;
  add(gW, box(p.palmH, palmW, gap2 * 1.6, 0.66), p.wristH + p.palmH / 2, 0, 0);
  const fingerGeo = new RoundedBoxGeometry(p.fingerLen, p.fingerW, gap2 * 1.2, 2, p.fingerW * 0.2);
  const fL = add(gW, pen.solid(fingerGeo, 0.12), p.wristH + p.palmH + p.fingerLen / 2, 0, 0);
  const fR = add(gW, pen.solid(fingerGeo, 0.12), p.wristH + p.palmH + p.fingerLen / 2, 0, 0);

  const gl = p.wristH + p.palmH + p.fingerLen;
  function setPose(q1, q2, open) {
    gL1.rotation.z = q1;
    gL2.rotation.z = q2;
    gW.rotation.z = -Math.PI / 2 - q1 - q2;
    const half = Math.max(0.01, Math.min(p.maxOpen, open)) / 2 + p.fingerW / 2;
    fL.position.y = half; fR.position.y = -half;
  }
  /* elbow-up IK for a tip that hangs straight down; y is up */
  function ik(tx, ty, prev) {
    let dx = tx - shoulder.x, dy = ty + gl - shoulder.y, d = Math.hypot(dx, dy);
    const maxR = p.L1 + p.L2 - 1e-3, minR = Math.abs(p.L1 - p.L2) + 0.05;
    if (d > maxR) { dx *= maxR / d; dy *= maxR / d; d = maxR; }
    if (d < minR) { dx *= minR / Math.max(d, 1e-6); dy *= minR / Math.max(d, 1e-6); d = minR; }
    const a = Math.atan2(dy, dx), c2 = (d * d - p.L1 * p.L1 - p.L2 * p.L2) / (2 * p.L1 * p.L2), b = Math.acos(Math.max(-1, Math.min(1, c2)));
    const sols = [b, -b].map(q2 => ({ q2, q1: a - Math.atan2(p.L2 * Math.sin(q2), p.L1 + p.L2 * Math.cos(q2)) }));
    sols.forEach(s => { s.ey = shoulder.y + p.L1 * Math.sin(s.q1); s.ex = shoulder.x + p.L1 * Math.cos(s.q1); });
    const ok = sols.filter(s => s.ey > shoulder.y - 0.1);
    const pool = ok.length ? ok : sols;
    if (!prev) { const side = Math.sign(dx) || 1; return pool.sort((m, n) => side * (n.ex - m.ex))[0]; }
    const ang = (x, y) => Math.atan2(Math.sin(x - y), Math.cos(x - y));
    return pool.sort((m, n) => (Math.abs(ang(m.q1, prev.q1)) + Math.abs(ang(m.q2, prev.q2))) - (Math.abs(ang(n.q1, prev.q1)) + Math.abs(ang(n.q2, prev.q2))))[0];
  }
  return { group: root, setPose, ik, shoulder, gl };
}

/* conveyor along +x from the origin; belt top at y = 0 */
export function conveyor(pen, L, legH) {
  const g = new THREE.Group();
  const r = 0.1, d = 0.6;
  const belt = pen.solid(new RoundedBoxGeometry(L, 2 * r, d, 4, r * 0.98), 0.8, { threshold: 40 });
  belt.position.set(L / 2, -r, 0); g.add(belt);
  [1, -1].forEach(sz => {
    const rail = pen.solid(new THREE.BoxGeometry(L - 0.1, r * 1.1, 0.03), 0.15);
    rail.position.set(L / 2, -r, sz * (d / 2 + 0.015)); g.add(rail);
  });
  for (let x = L * 0.12; x < L - 0.1; x += Math.max(1.4, L * 0.35)) {
    [1, -1].forEach(sz => { const leg = pen.solid(new THREE.BoxGeometry(0.07, legH, 0.07), 0.2); leg.position.set(x, -2 * r - legH / 2, sz * d * 0.4); g.add(leg); });
  }
  const motor = pen.solid(new RoundedBoxGeometry(0.3, 0.18, 0.3, 2, 0.02), 0.66); motor.position.set(0.2, -2 * r - 0.1, d * 0.2); g.add(motor);
  const cleats = [], gapC = 0.42, cleatGeo = new THREE.BoxGeometry(0.05, 0.03, d * 0.92);
  for (let x = r; x < L - r; x += gapC) { const c = new THREE.Mesh(cleatGeo, pen.hatch(0.95)); c.position.set(x, 0.012, 0); g.add(c); cleats.push(c); }
  let off = 0;
  g.userData.advance = dx => {
    off = (off + dx) % gapC;
    cleats.forEach((c, i) => { c.position.x = r + ((i * gapC + off) % (cleats.length * gapC)); c.visible = c.position.x < L - r; });
  };
  return g;
}
