/* Homepage workcell. A robot arm, the section objects and the name blocks run
   on 2D physics (Matter.js) in the plane of the table and are drawn in 3D with
   flat ink tones (three.js). Put an object on the conveyor; when it rides off
   the edge, its page opens. */
import * as THREE from 'three';
import * as C from './cell3d.js';

const stage = document.getElementById('stage');
const M = window.Matter;
// Vercel Web Analytics. The stub in the page's <head> queues events until its script loads.
const track = (name, data) => { try { if (window.va) window.va('event', { name, data }); } catch (_) {} };

function hasWebGL() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); }
  catch (_) { return false; }
}

if (stage && M && hasWebGL()) {
  const fonts = document.fonts
    ? Promise.race([document.fonts.load('extra-condensed 900 100px Archivo').then(() => document.fonts.ready), new Promise(r => setTimeout(r, 2500))])
    : Promise.resolve();
  fonts.then(start, start);
}

function start() {
  const { Engine, Bodies, Body, Composite, Constraint, Query, Sleeping, Vertices } = M;
  const glHost = stage.querySelector('.stage-gl');
  const overlay = stage.querySelector('.stage-notes');
  const nameWrap = stage.querySelector('.name-blocks');
  const tools = stage.querySelector('.stage-tools');
  const howto = stage.querySelector('.howto');
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const TILT = 0.22, CT = Math.cos(TILT), ST = Math.sin(TILT);
  const PU = 100;                         // physics units per world unit
  const CAT_GRIP = 0x0002, CAT_SHELF = 0x0004, CAT_ITEM = 0x0008, ALL = 0xFFFFFFFF;
  // A carried object passes through shelves and other objects. Once let go it lands on
  // shelves and the belt, but stays a ghost to other objects until it is clear of them.
  const CARRY_MASK = ALL & ~CAT_GRIP & ~CAT_SHELF & ~CAT_ITEM, LANDING_MASK = ALL & ~CAT_GRIP & ~CAT_ITEM;
  const SECTIONS = {
    espresso: ['/about/', 'About'], bison: ['/companies/', 'Companies'], book: ['/writing/', 'Writing'],
    helmet: ['/adventures/', 'Adventures'], walker: ['/robot-training/', 'Robot training'], envelope: ['/contact/', 'Contact']
  };
  const HULL = {
    espresso: [[-0.68, 0], [0.68, 0], [0.68, 1.04], [-0.68, 1.04]],
    bison: [[-0.53, 0], [0.68, 0], [0.87, 0.33], [0.77, 0.65], [-0.25, 1.06], [-0.72, 0.9], [-0.89, 0.36]],
    book: [[-1.15, 0], [1.15, 0], [1.15, 0.5], [-1.15, 0.5]],
    helmet: [[-0.8, 0], [0.86, 0], [0.88, 0.16], [0.6, 0.47], [0.15, 0.63], [-0.35, 0.58], [-0.68, 0.38], [-0.8, 0.16]],
    walker: [[-0.42, 0], [0.42, 0], [0.58, 0.2], [0.52, 0.66], [0.3, 0.78], [-0.52, 0.66], [-0.68, 0.5], [-0.6, 0.18]],
    envelope: [[-0.75, 0], [0.75, 0], [0.75, 1.0], [-0.75, 1.0]]
  };

  /* ---------- name blocks: real DOM letters ---------- */
  const rows = Array.from(nameWrap.querySelectorAll('.row')).map(r => r.textContent.trim());
  nameWrap.textContent = '';
  const letterEls = [];
  rows.forEach((word, ri) => {
    for (const ch of word) {
      const el = document.createElement('span'); el.className = 'blk'; el.dataset.row = ri;
      const g = document.createElement('span'); g.className = 'g'; g.textContent = ch;
      el.appendChild(g); nameWrap.appendChild(el); letterEls.push(el);
    }
  });
  stage.classList.add('is-live');

  const FM = (() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;left:0;top:0;font-weight:900;font-stretch:62%;font-size:100px;line-height:100px;white-space:nowrap';
    probe.innerHTML = '<span>H</span><span class="b" style="display:inline-block;width:1px;height:0;vertical-align:baseline"></span><span class="c" style="display:inline-block;width:1px;height:1cap;vertical-align:baseline"></span>';
    stage.appendChild(probe);
    const top = probe.getBoundingClientRect().top;
    const base = probe.querySelector('.b').getBoundingClientRect().top - top;
    const cap = probe.querySelector('.c').getBoundingClientRect().height || 72;
    probe.remove();
    return { base: base / 100, cap: cap / 100 };
  })();

  /* ---------- renderer ---------- */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;
  glHost.appendChild(renderer.domElement);
  const camera = new THREE.OrthographicCamera(0, 1, 1, 0, 0.1, 300);
  camera.rotation.x = -TILT;

  /* ---------- state ---------- */
  let W = 0, H = 0, L = null, scene = null, armScene = null, pen = null, engine = null;
  let items = [], letters = [], robot = null, conveyorG = null, belt = null, grip = null, appleRig = null;
  let dyn = [];                            // all dynamic bodies
  const byBody = new Map();
  const arm = { q1: 0, q2: 0, t1: 0, t2: 0, open: 1, openTarget: 1, tip: { x: 0, y: 0 }, prevTip: null, target: { x: 0, y: 0 }, sol: null };
  let hold = null, wantGrip = false, pendingRelease = false, missT = 0;
  const ptr = { down: false, sx: 0, sy: 0, moved: false, hadHold: false, type: 'mouse', inside: false };
  let lastInput = 0, now = 0, shipped = false, message = null, running = false, visible = true;
  let nodes = {};                          // overlay svg elements

  /* ---------- mapping between screen, world and physics ---------- */
  const toScreen = (x, y, z = 0) => [x * L.s, (H - L.tablePx) - (y * CT - z * ST) * L.s];
  const toWorld = (X, Y) => [X / L.s, ((H - L.tablePx) - Y) / (L.s * CT)];
  const P = (x, y) => ({ x: x * PU, y: -y * PU });        // world -> physics
  const Wd = v => [v.x / PU, -v.y / PU];                  // physics -> world

  /* ---------- layout, in world units with the table top at y = 0 ---------- */
  function layout() {
    const wide = W >= 1000;
    const s = wide ? Math.max(52, Math.min(84, W / 19)) : Math.max(36, Math.min(54, W / 8.6));
    const tablePx = wide ? 40 : 32;
    const Wu = W / s, Hu = (H - tablePx) / (s * CT);
    const lay = { wide, s, tablePx, Wu, Hu, m: wide ? 0.6 : 0.35 };

    // letters
    const F = wide ? Math.min(W * 0.08, H * 0.19, 140) : Math.min(W * 0.115, 56);
    const capPx = Math.round(FM.cap * F), gy = capPx - FM.base * F, gap = Math.max(2, Math.round(F * 0.035));
    letterEls.forEach(el => { el.style.fontSize = F + 'px'; el.style.height = capPx + 'px'; el.firstChild.style.top = gy + 'px'; });
    const widths = letterEls.map(el => Math.ceil(el.firstChild.offsetWidth));
    const rowW = [0, 0];
    letterEls.forEach((el, i) => { rowW[+el.dataset.row] += widths[i] + gap; });
    const capU = capPx / (s * CT);
    // On narrow screens the name sits at the top; drop it below the tool buttons when they would overlap.
    let topPad = 0.45;
    if (!wide && tools.offsetWidth && lay.m * s + Math.max(rowW[0], rowW[1]) + 24 > tools.offsetLeft) {
      topPad = Math.max(topPad, (tools.offsetTop + tools.offsetHeight + 10) / (s * CT) - 0.1);
    }
    lay.letterBase = wide ? 0 : lay.Hu - topPad - capU * 2 - 0.1;
    lay.letterShelf = wide ? null : { x0: 0, x1: (Math.max(rowW[0], rowW[1]) + 16) / s + lay.m, y: lay.letterBase };
    const cursor = [lay.m * s, lay.m * s];
    lay.letters = letterEls.map((el, i) => {
      const r = +el.dataset.row, w = widths[i];
      const bottom = r === 1 ? lay.letterBase : lay.letterBase + capU + 0.01;
      const cx = (cursor[r] + w / 2) / s;
      cursor[r] += w + gap;
      el.style.width = w + 'px';
      return { el, wPx: w, hPx: capPx, wU: w / s, hU: capU, x: cx, y: bottom + capU / 2 };
    });
    const lettersRight = Math.max(rowW[0], rowW[1]) / s + lay.m;
    const lettersTop = wide ? capU * 2 : lay.letterBase + capU * 2;

    // shelves and what sits on them
    const shelf1Kinds = ['espresso', 'bison', 'book'], shelf2Kinds = ['helmet', 'walker', 'envelope'];
    const widthOf = k => { const h = HULL[k]; return Math.max(...h.map(p => p[0])) - Math.min(...h.map(p => p[0])); };
    if (wide) {
      const x0 = lay.m, x1 = Math.max(lay.Wu * 0.42, x0 + 8.6);
      const y2 = Math.max(lettersTop + 1.1, lay.Hu * 0.42), y1 = y2 + 2.3;
      lay.shelves = [{ x0, x1, y: y1, kinds: shelf1Kinds }, { x0, x1, y: y2, kinds: shelf2Kinds }];
      lay.baseX = lay.Wu * 0.52;
      lay.conv = { x0: lay.Wu * 0.64, y: 1.45 };
      lay.apple = { x: Math.min(lettersRight + 1.0, lay.baseX - 1.9), y: 0 };
    } else {
      const x0 = lay.m, x1 = lay.Wu - lay.m;
      const y1 = lay.letterBase - 2.0, y2 = y1 - 2.0;
      lay.shelves = [{ x0, x1, y: y1, kinds: shelf1Kinds }, { x0, x1, y: y2, kinds: shelf2Kinds }];
      lay.baseX = lay.Wu * 0.3;
      lay.conv = { x0: lay.Wu * 0.52, y: 1.05 };
      lay.apple = { x: lay.m + 0.7, y: 0 };
    }
    lay.objects = [];
    lay.shelves.forEach(sh => {
      const total = sh.kinds.reduce((a, k) => a + widthOf(k), 0);
      const spare = (sh.x1 - sh.x0) - total, step = spare / (sh.kinds.length + 1);
      let x = sh.x0 + step * 0.9;
      sh.kinds.forEach(k => {
        const h = HULL[k], minX = Math.min(...h.map(p => p[0]));
        lay.objects.push({ kind: k, x: x - minX, y: sh.y });
        x += widthOf(k) + step;
      });
    });

    // arm sized to reach everything
    const k = wide ? 1 : 0.82;
    const A = { baseW: 1.6 * k, baseH: 0.66 * k, turretH: 0.46 * k, t1: 0.56 * k, t2: 0.46 * k, wristH: 0.25 * k, palmH: 0.25 * k, fingerLen: 0.6 * k, fingerW: 0.14 * k, maxOpen: 0.95 * k };
    const gl = A.wristH + A.palmH + A.fingerLen;
    const sh = { x: lay.baseX, y: A.baseH + A.turretH };
    let R = 0;
    const reach = (x, y) => { R = Math.max(R, Math.hypot(x - sh.x, y + gl - sh.y)); };
    lay.objects.forEach(o => reach(o.x, o.y + 0.5));
    reach(lay.conv.x0 + 3.5, lay.conv.y + 0.6);
    reach(lay.apple.x, 0.5);
    R *= 1.05;
    A.L1 = R * 0.53; A.L2 = R * 0.47;
    lay.A = A; lay.gl = gl; lay.shoulder = sh;
    lay.home = wide ? { x: lay.baseX + 1.9, y: lay.conv.y + 2.4 } : { x: lay.baseX + 1.5, y: lay.conv.y + 2.2 };
    lay.carryY = Math.min(lay.Hu - 0.7, sh.y + (A.L1 + A.L2) * 0.82 - gl);   // tip height for crossing the base
    return lay;
  }

  /* ---------- build the scene and the physics world ---------- */
  function build() {
    W = stage.clientWidth; H = stage.clientHeight;
    renderer.setSize(W, H, false);
    pen = new C.Pen(renderer, { mode: 'tone' });
    L = layout();
    camera.left = 0; camera.right = W / L.s; camera.top = (H - L.tablePx) / L.s; camera.bottom = -L.tablePx / L.s;
    camera.position.set(0, 80 * ST, 80 * CT);
    camera.updateProjectionMatrix(); camera.updateMatrixWorld();

    scene = new THREE.Scene();
    armScene = new THREE.Scene();
    engine = Engine.create({ enableSleeping: true, positionIterations: 10, velocityIterations: 8 });
    engine.gravity.y = 1; engine.gravity.scale = 0.0016;
    items = []; letters = []; dyn = []; byBody.clear(); hold = null; wantGrip = false; pendingRelease = false;

    // table: the top at y = 0, the front face fills the strip below
    const depthDown = L.tablePx / (L.s * CT) + 1;
    const table = pen.solid(new THREE.BoxGeometry(L.Wu + 4, depthDown, 2.8), 0.05, { threshold: 30 });
    table.position.set(L.Wu / 2, -depthDown / 2, 1.4); scene.add(table);

    const S = (x, y, w, h, extra) => Bodies.rectangle(x * PU, -y * PU, w * PU, h * PU, Object.assign({ isStatic: true, friction: 0.8 }, extra));
    const statics = [
      S(L.Wu / 2, -5, L.Wu + 40, 10),                           // table
      S(-1, L.Hu / 2, 2, L.Hu * 4),                             // left wall
      S(L.Wu / 2, L.Hu + 6, L.Wu + 40, 2)                       // ceiling, well above the sheet
    ];

    // shelves
    const shelfFilter = { category: CAT_SHELF, mask: ALL, group: 0 };
    L.shelves.forEach(sh => {
      const g = C.shelf(pen, sh.x1 - sh.x0); g.position.set((sh.x0 + sh.x1) / 2, sh.y, 0); scene.add(g);
      statics.push(S((sh.x0 + sh.x1) / 2, sh.y - 0.03, sh.x1 - sh.x0, 0.06, { collisionFilter: shelfFilter }));
    });
    if (L.letterShelf) {
      const ls = L.letterShelf;
      const g = C.shelf(pen, ls.x1 - ls.x0, 0.9); g.position.set((ls.x0 + ls.x1) / 2, ls.y, 0.45); scene.add(g);
      statics.push(S((ls.x0 + ls.x1) / 2, ls.y - 0.03, ls.x1 - ls.x0, 0.06, { collisionFilter: shelfFilter }));
    }

    // arm
    robot = C.arm(pen, L.A);
    robot.group.position.set(L.baseX, 0, 0);
    armScene.add(robot.group);
    statics.push(S(L.baseX, L.A.baseH / 2, L.A.baseW, L.A.baseH), S(L.baseX, L.A.baseH + L.A.turretH / 2, L.A.t1 * 1.8, L.A.turretH));

    // conveyor, running off the right edge
    const convLen = L.Wu - L.conv.x0 + 2;
    conveyorG = C.conveyor(pen, convLen, L.conv.y - 0.2);
    conveyorG.position.set(L.conv.x0, L.conv.y, 0); scene.add(conveyorG);
    belt = S(L.conv.x0 + convLen / 2, L.conv.y - 0.1, convLen, 0.2, { friction: 1 });
    statics.push(belt);
    statics.push(S(L.Wu + 1, (L.conv.y - 0.25) / 2, 2, L.conv.y - 0.25));   // stop things on the floor rolling away

    Composite.add(engine.world, statics);

    // section objects
    const builders = {
      espresso: () => C.espresso(pen), bison: () => C.bison(pen), book: () => C.book(pen, 'Writing', 1.0),
      helmet: () => C.helmet(pen, { frontStraps: true }), walker: () => C.walker(pen), envelope: () => C.envelope(pen, 'Contact')
    };
    L.objects.forEach(o => {
      const model = builders[o.kind]();
      scene.add(model.group);
      const verts = HULL[o.kind].map(([x, y]) => ({ x: x * PU, y: -y * PU }));
      const c = Vertices.centre(verts);
      const body = Bodies.fromVertices(o.x * PU + c.x, -o.y * PU + c.y, [verts], { friction: 0.7, frictionStatic: 0.9, restitution: 0.03, density: 0.0016 });
      const it = {
        kind: o.kind, body, group: model.group, anchor: model.anchor, off: { x: -c.x / PU, y: c.y / PU },
        href: SECTIONS[o.kind][0], label: SECTIONS[o.kind][1], home: { x: body.position.x, y: body.position.y }, lastBelt: -9, lastHeld: -9
      };
      addDynamic(it);
    });

    // the skater apple: a chassis plus two wheels on pins
    {
      const model = C.apple(pen);
      scene.add(model.group);
      const ax = L.apple.x;
      const deck = Bodies.rectangle(ax * PU, -0.18 * PU, 1.24 * PU, 0.07 * PU);
      const ball = Bodies.circle(ax * PU, -(0.19 + 0.33) * PU, 0.39 * PU);
      const chassis = Body.create({ parts: [deck, ball], friction: 0.5, restitution: 0.1, collisionFilter: { group: -2, category: 1, mask: ALL } });
      Body.setDensity(chassis, 0.0012);
      const wheels = [-0.36, 0.36].map(dx => Bodies.circle((ax + dx) * PU, -0.065 * PU, 0.065 * PU, { friction: 0.9, restitution: 0.05, density: 0.002, collisionFilter: { group: -2, category: 1, mask: ALL } }));
      const pins = wheels.map(w => Constraint.create({ bodyA: chassis, pointA: { x: w.position.x - chassis.position.x, y: w.position.y - chassis.position.y }, bodyB: w, stiffness: 0.95, length: 0 }));
      Composite.add(engine.world, [...wheels, ...pins]);
      const it = { kind: 'apple', body: chassis, group: model.group, anchor: null, off: { x: ax - chassis.position.x / PU, y: chassis.position.y / PU }, href: null, label: null, home: { x: chassis.position.x, y: chassis.position.y }, lastBelt: -9, lastHeld: -9, wheels, wheelMeshes: model.wheels };
      it.wheelHome = wheels.map(w => ({ x: w.position.x, y: w.position.y }));
      appleRig = it;
      addDynamic(it);
      wheels.forEach(w => { dyn.push(w); byBody.set(w, it); });
    }

    // name blocks
    L.letters.forEach(l => {
      const body = Bodies.rectangle(l.x * PU, -l.y * PU, l.wU * PU, l.hU * PU, { friction: 0.6, frictionStatic: 0.9, restitution: 0.02, density: 0.0014 });
      const rec = { kind: 'letter', el: l.el, body, wPx: l.wPx, hPx: l.hPx, home: { x: body.position.x, y: body.position.y }, lastBelt: -9, lastHeld: -9 };
      letters.push(rec);
      addDynamic(rec);
    });

    // gripper: three static bodies the arm drags around
    const gf = { group: 0, category: CAT_GRIP, mask: 0 };
    const A = L.A;
    grip = {
      palm: Bodies.rectangle(0, 0, (A.maxOpen + 2 * A.fingerW + 0.04) * PU, A.palmH * PU, { isStatic: true, collisionFilter: { ...gf } }),
      fl: Bodies.rectangle(0, 0, A.fingerW * PU, A.fingerLen * PU, { isStatic: true, collisionFilter: { ...gf } }),
      fr: Bodies.rectangle(0, 0, A.fingerW * PU, A.fingerLen * PU, { isStatic: true, collisionFilter: { ...gf } })
    };
    grip.all = [grip.palm, grip.fl, grip.fr];
    Composite.add(engine.world, grip.all);

    // arm starts folded and unfolds to its home pose
    arm.target = { ...L.home };
    arm.sol = robot.ik(L.home.x - L.baseX, L.home.y, null);
    if (reduce) { arm.q1 = arm.sol.q1; arm.q2 = arm.sol.q2; }
    else { arm.q1 = Math.PI / 2 + 0.25; arm.q2 = -2.4; }
    arm.open = 1; arm.openTarget = 1;
    arm.introUntil = now + (reduce ? 0 : 1.8);
    fk();

    buildOverlay();
    sync();
  }

  function addDynamic(it) {
    itemBodies(it).forEach(b => setCategory(b, CAT_ITEM));
    Composite.add(engine.world, it.body);
    dyn.push(it.body);
    byBody.set(it.body, it);
    if (it.kind !== 'letter') items.push(it);       // letters live in their own list
  }

  /* ---------- arm kinematics ---------- */
  function fk() {
    const A = L.A, S = L.shoulder;
    const ex = S.x + A.L1 * Math.cos(arm.q1), ey = S.y + A.L1 * Math.sin(arm.q1);
    const wx = ex + A.L2 * Math.cos(arm.q1 + arm.q2), wy = ey + A.L2 * Math.sin(arm.q1 + arm.q2);
    arm.elbow = { x: ex, y: ey }; arm.wrist = { x: wx, y: wy }; arm.tip = { x: wx, y: wy - L.gl };
  }

  function setTarget(x, y) {
    arm.target.x = Math.max(0.2, Math.min(L.Wu - 0.2, x));
    arm.target.y = Math.max(0.04, Math.min(L.Hu + 1, y));
  }

  /* Carrying across the arm's base on a wide layout: lift, cross high, then lower.
     Otherwise the elbow flips mid-move and the gripper sweeps through the shelves. */
  let route = null;
  function carryGoal() {
    const t = arm.target;
    if (!hold || !L.wide) { route = null; return t; }
    const sx = L.shoulder.x, tip = arm.tip, H = L.carryY;
    const side = x => (x < sx ? -1 : 1);
    const crossing = side(tip.x) !== side(t.x);
    if (!route) {
      if (!crossing) return t;
      route = { phase: tip.y >= H - 0.25 ? 'cross' : 'lift', x: tip.x, n: 0 };
    }
    if (route.phase === 'lift') {
      if (!crossing) { route = null; return t; }
      if (tip.y >= H - 0.25 || (route.n++ > 6 && arm.err < 0.02)) route.phase = 'cross';
      else return { x: route.x, y: H };
    }
    if (side(tip.x) === side(t.x) && Math.abs(tip.x - t.x) < 0.9) { route = null; return t; }
    return { x: t.x, y: Math.max(t.y, H) };
  }

  function servo(dt) {
    const goal = carryGoal();
    const sol = robot.ik(goal.x - L.baseX, goal.y, arm.sol || { q1: arm.q1, q2: arm.q2 });
    arm.sol = sol;
    const ang = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
    const wmax = (L.wide ? 2.8 : 2.4) * (route ? 1.3 : 1);
    const t1 = arm.q1 + ang(sol.q1, arm.q1), t2 = arm.q2 + ang(sol.q2, arm.q2);
    const step = (q, t) => q + Math.max(-wmax * dt, Math.min(wmax * dt, (t - q) * 9 * dt));
    arm.err = Math.abs(t1 - arm.q1) + Math.abs(t2 - arm.q2);
    arm.q1 = step(arm.q1, t1); arm.q2 = step(arm.q2, t2);
    fk();
  }

  const arrived = () => arm.err < 0.02 && !route;

  function placeGripper() {
    const A = L.A, t = arm.tip;
    const open = Math.max(0.03, A.maxOpen * arm.open);
    const prev = arm.prevTip || t;
    const speed = Math.hypot(t.x - prev.x, t.y - prev.y) * PU;      // physics units per step
    arm.prevTip = { ...t };
    const userDriven = now - lastInput < 0.4 && now > arm.introUntil;
    const collide = !hold && !wantGrip && speed > 6 && userDriven;   // an empty gripper can still knock things over
    grip.all.forEach(b => { b.collisionFilter.mask = collide ? (ALL & ~CAT_SHELF) : 0; });
    Body.setPosition(grip.palm, P(t.x, t.y + A.fingerLen + A.palmH / 2), true);
    Body.setPosition(grip.fl, P(t.x - open / 2 - A.fingerW / 2, t.y + A.fingerLen / 2), true);
    Body.setPosition(grip.fr, P(t.x + open / 2 + A.fingerW / 2, t.y + A.fingerLen / 2), true);
    if (collide) {
      const p = P(t.x, t.y);
      const r = (A.maxOpen + 0.4) * PU;
      Query.region(dyn, { min: { x: p.x - r, y: p.y - (L.gl + 0.3) * PU }, max: { x: p.x + r, y: p.y + 0.3 * PU } }).forEach(b => Sleeping.set(b, false));
    }
  }

  /* ---------- holding ---------- */
  const DEFAULT_MASK = ALL;
  function setMask(body, mask) {
    body.collisionFilter = { ...body.collisionFilter, mask };
    body.parts.forEach(p => { p.collisionFilter = body.collisionFilter; });
  }
  function setCategory(body, category) {
    body.collisionFilter = { ...body.collisionFilter, category };
    body.parts.forEach(p => { p.collisionFilter = body.collisionFilter; });
  }
  function itemBodies(it) { return it.wheels ? [it.body, ...it.wheels] : [it.body]; }
  function setItemMask(it, mask) { itemBodies(it).forEach(b => setMask(b, mask)); }
  const ghosts = new Set();
  function overlapsOthers(it) {
    const mine = itemBodies(it), others = dyn.filter(b => !mine.includes(b));
    return mine.some(b => Query.collides(b, others).length > 0);
  }
  function settle(it) {
    if (overlapsOthers(it)) { setItemMask(it, LANDING_MASK); ghosts.add(it); }
    else { setItemMask(it, DEFAULT_MASK); ghosts.delete(it); }
  }

  function tryGrab() {
    const t = arm.tip;
    const probes = [P(t.x, t.y + L.A.fingerLen * 0.3), P(t.x, t.y), P(t.x, t.y - 0.12)];
    let found = null, at = null;
    for (const pt of probes) { const hits = Query.point(dyn, pt); if (hits.length) { found = hits[0]; at = pt; break; } }
    if (!found) {
      const p = P(t.x, t.y), r = L.A.maxOpen * 0.6 * PU;
      let best = Infinity;
      Query.region(dyn, { min: { x: p.x - r, y: p.y - r }, max: { x: p.x + r, y: p.y + r } }).forEach(b => {
        const d = Math.hypot(b.position.x - p.x, b.position.y - p.y);
        if (d < best) { best = d; found = b; }
      });
      at = P(t.x, t.y + L.A.fingerLen * 0.3);
    }
    if (!found) return false;
    let it = byBody.get(found);
    let body = found;
    if (it && it.wheels && found !== it.body) body = it.body;     // grabbing a wheel picks up the whole skateboard
    if (!it) return false;
    const c = Constraint.create({ pointA: { ...at }, bodyB: body, pointB: { x: at.x - body.position.x, y: at.y - body.position.y }, stiffness: 0.55, damping: 0.12, length: 0 });
    Composite.add(engine.world, c);
    setItemMask(it, CARRY_MASK); ghosts.delete(it);
    body.frictionAir = 0.05;
    Sleeping.set(body, false);
    hold = { it, body, c, dy: (at.y / -PU) - t.y };
    if (it.el) it.el.classList.add('is-held');
    const w = it.kind === 'letter' ? it.wPx / L.s : 0.3;
    arm.openTarget = Math.min(1, Math.max(0.12, (w * 0.9) / L.A.maxOpen));
    return true;
  }

  function release() {
    if (!hold) return;
    Composite.remove(engine.world, hold.c);
    settle(hold.it);
    hold.body.frictionAir = 0.01;
    if (hold.it.el) hold.it.el.classList.remove('is-held');
    hold.it.lastHeld = now;
    hold = null; arm.openTarget = 1; pendingRelease = false;
  }

  /* ---------- conveyor and shipping ---------- */
  const BELT_V = 4.0;                     // physics units per step
  function driveBelt() {
    engine.pairs.list.forEach(pair => {
      if (!pair.isActive) return;
      const a = pair.bodyA.parent, b = pair.bodyB.parent;
      const other = a === belt ? b : (b === belt ? a : null);
      if (!other || (hold && hold.body === other)) return;
      Sleeping.set(other, false);
      Body.setVelocity(other, { x: other.velocity.x + (BELT_V - other.velocity.x) * 0.3, y: other.velocity.y });
      const it = byBody.get(other);
      if (it) { it.lastBelt = now; if (it.href) prefetch(it.href); }
    });
  }

  function resetBody(it) {
    ghosts.delete(it); setItemMask(it, DEFAULT_MASK);
    const b = it.body;
    Body.setPosition(b, it.home); Body.setAngle(b, 0);
    Body.setVelocity(b, { x: 0, y: 0 }); Body.setAngularVelocity(b, 0);
    if (it.wheels) it.wheels.forEach((w, i) => { Body.setPosition(w, it.wheelHome[i]); Body.setVelocity(w, { x: 0, y: 0 }); Body.setAngularVelocity(w, 0); });
    Sleeping.set(b, false);
  }

  function checkBounds() {
    const right = (L.Wu + 0.9) * PU;
    for (const it of [...items, ...letters]) {
      const b = it.body;
      if (hold && hold.body === b) continue;
      const lost = !isFinite(b.position.x) || b.position.y > 3 * PU || b.position.x < -3 * PU;
      if (b.position.x > right) {
        if (it.href && now - it.lastBelt < 1.5) ship(it);
        else if (it.kind === 'apple') {
          Body.setPosition(b, { x: -0.8 * PU, y: it.home.y - 0.3 * PU }); Body.setVelocity(b, { x: 3.5, y: 0 });
          it.wheels.forEach((w, i) => { Body.setPosition(w, { x: -0.8 * PU + (it.wheelHome[i].x - it.home.x), y: it.wheelHome[i].y - 0.3 * PU }); Body.setVelocity(w, { x: 3.5, y: 0 }); });
        } else resetBody(it);
      } else if (lost) resetBody(it);
    }
  }

  const prefetched = new Set();
  function prefetch(href) {
    if (prefetched.has(href)) return;
    prefetched.add(href);
    const l = document.createElement('link'); l.rel = 'prefetch'; l.href = href;
    document.head.appendChild(l);
  }

  function ship(it) {
    resetBody(it);
    shipped = true;
    track('Arm opened page', { page: it.label });
    message = { text: `Opening ${it.label}`, until: now + 3 };
    setTimeout(() => { location.href = it.href; }, reduce ? 50 : 450);
  }
  // Coming back with the back button restores this page as it was; clear the note.
  window.addEventListener('pageshow', e => { if (e.persisted) message = null; });

  /* ---------- overlay: callouts, joint angles, redline notes ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); (parent || overlay).appendChild(e); return e; };

  function buildOverlay() {
    overlay.innerHTML = '';
    overlay.setAttribute('viewBox', `0 0 ${W} ${H}`);
    nodes = { callouts: [] };
    items.filter(it => it.anchor).forEach(it => {
      const g = mk('g', {});
      nodes.callouts.push({
        it, dot: mk('circle', { r: 2.3, fill: '#1D2766' }, g),
        line: mk('path', { fill: 'none', stroke: '#1D2766', 'stroke-width': 1 }, g),
        text: Object.assign(mk('text', { 'font-size': L.wide ? 17 : 14, fill: '#1D2766', class: 'callout' }, g), { textContent: it.label })
      });
    });
    const ang = mk('g', { fill: 'none', stroke: '#555D8B', 'stroke-width': 1 });
    nodes.ref = mk('path', { 'stroke-dasharray': '4 3' }, ang);
    nodes.arc1 = mk('path', {}, ang);
    nodes.ext = mk('path', { 'stroke-dasharray': '4 3' }, ang);
    nodes.arc2 = mk('path', {}, ang);
    nodes.deg1 = mk('text', { class: 'deg', fill: '#555D8B', 'font-size': 12, stroke: 'none' });
    nodes.deg2 = mk('text', { class: 'deg', fill: '#555D8B', 'font-size': 12, stroke: 'none' });
    const red = mk('g', { class: 'redline' });
    nodes.hintLine = mk('path', { fill: 'none', stroke: '#F0441C', 'stroke-width': 1.5, 'stroke-dasharray': '6 4' }, red);
    nodes.hintHead = mk('path', { fill: 'none', stroke: '#F0441C', 'stroke-width': 1.5 }, red);
    nodes.hintText = mk('text', { fill: '#BF2F0E', 'font-size': L.wide ? 14 : 12, class: 'hint', 'text-anchor': 'end' }, red);
    nodes.msg = mk('text', { fill: '#BF2F0E', 'font-size': L.wide ? 16 : 13, class: 'hint', 'text-anchor': 'end' });
  }

  function drawOverlay() {
    // callouts follow their objects
    nodes.callouts.forEach(c => {
      const b = c.it.body, a = -b.angle;
      const [cx, cy] = Wd(b.position);
      const ox = c.it.anchor.x + c.it.off.x, oy = c.it.anchor.y + c.it.off.y;
      const wx = cx + ox * Math.cos(a) - oy * Math.sin(a), wy = cy + ox * Math.sin(a) + oy * Math.cos(a);
      const [X, Y] = toScreen(wx, wy, c.it.anchor.z || 0);
      const dir = X > W - 130 ? -1 : 1;
      const lift = c.it.kind === 'walker' && L.wide ? 42 : 20;   // clear the envelope beside it
      const tx = X + dir * 24, ty = Y - lift;
      c.dot.setAttribute('cx', X.toFixed(1)); c.dot.setAttribute('cy', Y.toFixed(1));
      c.line.setAttribute('d', `M ${X.toFixed(1)} ${Y.toFixed(1)} L ${tx.toFixed(1)} ${ty.toFixed(1)} h ${dir * 8}`);
      c.text.setAttribute('x', (tx + dir * 12).toFixed(1)); c.text.setAttribute('y', (ty + 6).toFixed(1));
      c.text.setAttribute('text-anchor', dir > 0 ? 'start' : 'end');
    });
    // joint angles, measured on screen
    const [sx, sy] = toScreen(L.shoulder.x, L.shoulder.y), [ex, ey] = toScreen(arm.elbow.x, arm.elbow.y), [wx, wy] = toScreen(arm.wrist.x, arm.wrist.y);
    const a1 = Math.atan2(ey - sy, ex - sx), a2 = Math.atan2(wy - ey, wx - ex);
    const r1 = L.wide ? 40 : 30, r2 = L.wide ? 30 : 22;
    nodes.ref.setAttribute('d', `M ${sx} ${sy} h ${r1 + 14}`);
    nodes.arc1.setAttribute('d', `M ${sx + r1} ${sy} A ${r1} ${r1} 0 0 ${a1 < 0 ? 0 : 1} ${sx + r1 * Math.cos(a1)} ${sy + r1 * Math.sin(a1)}`);
    nodes.deg1.setAttribute('x', (sx + (r1 + 12) * Math.cos(a1 / 2) + 2).toFixed(1));
    nodes.deg1.setAttribute('y', (sy + (r1 + 12) * Math.sin(a1 / 2) + 4).toFixed(1));
    nodes.deg1.textContent = Math.round(Math.abs(a1) * 180 / Math.PI) + '°';
    const rel = Math.atan2(Math.sin(a2 - a1), Math.cos(a2 - a1));
    nodes.ext.setAttribute('d', `M ${ex} ${ey} l ${(r2 + 12) * Math.cos(a1)} ${(r2 + 12) * Math.sin(a1)}`);
    nodes.arc2.setAttribute('d', `M ${ex + r2 * Math.cos(a1)} ${ey + r2 * Math.sin(a1)} A ${r2} ${r2} 0 0 ${rel > 0 ? 1 : 0} ${ex + r2 * Math.cos(a2)} ${ey + r2 * Math.sin(a2)}`);
    const am = a1 + rel / 2;
    nodes.deg2.setAttribute('x', (ex + (r2 + 14) * Math.cos(am)).toFixed(1));
    nodes.deg2.setAttribute('y', (ey + (r2 + 14) * Math.sin(am) + 4).toFixed(1));
    nodes.deg2.textContent = Math.round(Math.abs(rel) * 180 / Math.PI) + '°';
    // redline: show where to put a held section object
    const showHint = hold && hold.it.href && !shipped;
    const [bx0, by] = toScreen(L.conv.x0 + 1.0, L.conv.y + 1.5), [bx1] = toScreen(L.Wu - 0.25, 0);
    nodes.hintLine.setAttribute('d', showHint ? `M ${bx0} ${by} H ${bx1}` : '');
    nodes.hintHead.setAttribute('d', showHint ? `M ${bx1 - 10} ${by - 6} L ${bx1} ${by} L ${bx1 - 10} ${by + 6}` : '');
    nodes.hintText.setAttribute('x', bx1); nodes.hintText.setAttribute('y', by - 10);
    nodes.hintText.textContent = showHint ? 'Set it on the belt to open its page' : '';
    nodes.msg.setAttribute('x', W - 18); nodes.msg.setAttribute('y', toScreen(0, L.conv.y + 0.55)[1]);
    nodes.msg.textContent = message && now < message.until ? message.text : '';
  }

  /* ---------- per-frame sync of models and letters to bodies ---------- */
  function sync() {
    items.forEach(it => {
      const b = it.body, a = -b.angle;
      const [cx, cy] = Wd(b.position);
      it.group.position.set(cx + it.off.x * Math.cos(a) - it.off.y * Math.sin(a), cy + it.off.x * Math.sin(a) + it.off.y * Math.cos(a), 0);
      it.group.rotation.z = a;
      if (it.wheels) it.wheels.forEach((w, i) => { it.wheelMeshes[i].rotation.z = -w.angle - a; });
    });
    letters.forEach(l => {
      const b = l.body;
      const [x, y] = Wd(b.position);
      const [X, Y] = toScreen(x, y);
      const key = `${X | 0},${Y | 0},${(b.angle * 500) | 0}`;
      if (key !== l.key) { l.key = key; l.el.style.transform = `translate(${(X - l.wPx / 2).toFixed(1)}px,${(Y - l.hPx / 2).toFixed(1)}px) rotate(${b.angle.toFixed(4)}rad)`; }
    });
    robot.setPose(arm.q1, arm.q2, Math.max(0.03, L.A.maxOpen * arm.open));
  }

  /* ---------- simulation step ---------- */
  const STEP = 1000 / 60;
  function step(dt) {
    now += dt;
    if (!ptr.inside && !ptr.down && !hold && now - lastInput > 1.6) setTarget(L.home.x, L.home.y);
    servo(dt);
    arm.open += (arm.openTarget - arm.open) * Math.min(1, dt * 14);
    placeGripper();
    if (hold) {
      hold.c.pointA = P(arm.tip.x, arm.tip.y + hold.dy);
      Sleeping.set(hold.body, false);
    }
    if (wantGrip && !hold && arrived()) {
      wantGrip = false;
      if (!tryGrab()) { arm.openTarget = 0.1; missT = 0.35; if (coach) coach.missed = true; }
    }
    if (missT > 0) { missT -= dt; if (missT <= 0 && !hold && !ptr.down) arm.openTarget = 1; }
    if (pendingRelease && arrived()) release();
    coachTick(dt);
    Engine.update(engine, STEP);
    if (ghosts.size) ghosts.forEach(it => { if (!overlapsOthers(it)) { setItemMask(it, DEFAULT_MASK); ghosts.delete(it); } });
    driveBelt();
    checkBounds();
    conveyorG.userData.advance(BELT_V / PU);
  }

  let acc = 0, last = 0;
  function frame(ts) {
    if (!running) return;
    const dt = Math.min(100, ts - (last || ts)); last = ts; acc += dt;
    let n = 0;
    while (acc >= STEP && n < 4) { step(STEP / 1000); acc -= STEP; n++; }
    if (n === 4) acc = 0;
    sync();
    drawOverlay();
    renderer.clear();
    renderer.render(scene, camera);
    renderer.clearDepth();
    renderer.render(armScene, camera);
    requestAnimationFrame(frame);
  }
  function play() { if (running || !visible || document.hidden) return; running = true; last = 0; requestAnimationFrame(frame); }
  function pause() { running = false; }

  /* ---------- input ---------- */
  const local = e => { const r = stage.getBoundingClientRect(); return toWorld(e.clientX - r.left, e.clientY - r.top); };

  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.stage-tools') || !howto.hidden) return;
    const [x, y] = local(e);
    ptr.down = true; ptr.sx = e.clientX; ptr.sy = e.clientY; ptr.moved = false; ptr.hadHold = !!hold; ptr.type = e.pointerType;
    setTarget(x, y);
    if (!hold) { wantGrip = true; pendingRelease = false; }
    if (e.pointerType === 'mouse') { e.preventDefault(); stage.focus({ preventScroll: true }); try { stage.setPointerCapture(e.pointerId); } catch (_) {} }
    lastInput = now;
  });
  stage.addEventListener('pointermove', e => {
    if (!howto.hidden) return;
    if (e.pointerType === 'mouse') ptr.inside = true;
    if (e.pointerType === 'mouse' || ptr.down) { const [x, y] = local(e); setTarget(x, y); lastInput = now; }
    if (ptr.down && Math.hypot(e.clientX - ptr.sx, e.clientY - ptr.sy) > 8) ptr.moved = true;
  });
  stage.addEventListener('pointerup', () => {
    if (!ptr.down) return;
    ptr.down = false;
    if (ptr.moved) { if (hold) release(); wantGrip = false; if (!hold) arm.openTarget = 1; }
    else if (ptr.hadHold) pendingRelease = true;
  });
  stage.addEventListener('pointercancel', () => { ptr.down = false; if (!hold) { wantGrip = false; arm.openTarget = 1; } });
  stage.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') ptr.inside = false; });

  stage.addEventListener('keydown', e => {
    if (e.target !== stage) return;
    const stepU = e.shiftKey ? 0.8 : 0.25;
    const moves = { ArrowLeft: [-stepU, 0], ArrowRight: [stepU, 0], ArrowUp: [0, stepU], ArrowDown: [0, -stepU] };
    if (moves[e.key]) { e.preventDefault(); setTarget(arm.target.x + moves[e.key][0], arm.target.y + moves[e.key][1]); lastInput = now; ptr.inside = true; return; }
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (hold) pendingRelease = true; else wantGrip = true; lastInput = now; }
    if (e.key === 'Escape') { release(); ptr.inside = false; }
  });
  stage.addEventListener('blur', () => { ptr.inside = false; });

  /* ---------- how it works: shown once on a first visit, then from its button ---------- */
  const HOWTO_KEY = 'calebappleton.howto.v1';
  const howtoBtn = tools.querySelector('[data-act="howto"]');
  function openHowto(focus, why) {
    howto.hidden = false;
    howtoBtn.setAttribute('aria-expanded', 'true');
    ptr.inside = false; ptr.down = false;
    if (focus) howto.querySelector('[data-howto="close"]').focus({ preventScroll: true });
    track('How-to card opened', { why });
  }
  function closeHowto(refocus, how) {
    if (howto.hidden) return;
    howto.hidden = true;
    howtoBtn.setAttribute('aria-expanded', 'false');
    try { localStorage.setItem(HOWTO_KEY, '1'); } catch (_) {}
    if (refocus) stage.focus({ preventScroll: true });
    track('How-to card closed', { how });
  }
  howtoBtn.addEventListener('click', () => (howto.hidden ? openHowto(true, 'How it works button') : closeHowto(true, 'How it works button')));
  howto.addEventListener('click', e => {
    const act = e.target.closest('[data-howto]');
    if (act) closeHowto(act.dataset.howto === 'close', act.dataset.howto === 'close' ? 'Try it' : 'Skip to the list of pages');
    else if (!e.target.closest('.howto-card')) closeHowto(true, 'Clicked outside the card');
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !howto.hidden) { e.preventDefault(); closeHowto(true, 'Escape'); } });
  howtoBtn.setAttribute('aria-expanded', 'false');

  // On a first visit with a mouse, let people play before explaining: show the card after a
  // couple of seconds of steering without picking anything up, or after a grab that misses.
  // Anyone who picks something up first has figured it out and never sees it. Touch screens
  // have no hover to hint that the arm follows you, so there the card shows right away.
  const noHover = window.matchMedia('(hover: none)').matches;
  let coach = { moving: 0, missed: false };
  try { if (localStorage.getItem(HOWTO_KEY) === '1') coach = null; } catch (_) {}
  function coachTick(dt) {
    if (!coach || !howto.hidden || now < arm.introUntil) return;
    if (hold) { coach = null; try { localStorage.setItem(HOWTO_KEY, '1'); } catch (_) {} return; }
    if (coach.missed) { if (missT <= 0) { coach = null; openHowto(false, 'Missed a grab'); } return; }
    if (now - lastInput < 0.5 && lastInput > arm.introUntil) coach.moving += dt;
    if (coach.moving > 2) { coach = null; openHowto(false, 'Steered without grabbing'); }
  }

  /* ---------- tools: reset and tilt ---------- */
  tools.querySelector('[data-act="reset"]').addEventListener('click', () => { build(); });
  const tiltBtn = tools.querySelector('[data-act="tilt"]');
  let tiltOn = false;
  if ('DeviceOrientationEvent' in window && window.matchMedia('(pointer: coarse)').matches) tiltBtn.hidden = false;
  function onTilt(e) {
    if (e.beta == null || e.gamma == null) return;
    let gx = Math.sin(e.gamma * Math.PI / 180), gy = Math.sin(e.beta * Math.PI / 180);
    const angle = (screen.orientation && screen.orientation.angle) || 0;
    if (angle === 90) [gx, gy] = [gy, -gx];
    else if (angle === 270 || angle === -90) [gx, gy] = [-gy, gx];
    else if (angle === 180) [gx, gy] = [-gx, -gy];
    if (Math.abs(gx - engine.gravity.x) + Math.abs(gy - engine.gravity.y) > 0.02) dyn.forEach(b => Sleeping.set(b, false));
    engine.gravity.x = gx; engine.gravity.y = gy;
  }
  tiltBtn.addEventListener('click', async () => {
    if (!tiltOn) {
      try {
        if (typeof DeviceOrientationEvent.requestPermission === 'function' && (await DeviceOrientationEvent.requestPermission()) !== 'granted') return;
      } catch (_) { return; }
      window.addEventListener('deviceorientation', onTilt);
      tiltOn = true; tiltBtn.setAttribute('aria-pressed', 'true'); tiltBtn.textContent = 'Tilt is on';
    } else {
      window.removeEventListener('deviceorientation', onTilt);
      tiltOn = false; engine.gravity.x = 0; engine.gravity.y = 1; dyn.forEach(b => Sleeping.set(b, false));
      tiltBtn.setAttribute('aria-pressed', 'false'); tiltBtn.textContent = 'Tilt to steer';
    }
  });

  /* ---------- lifecycle ---------- */
  let lastW = 0, lastH = 0, resizeT = 0;
  new ResizeObserver(() => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (Math.abs(w - lastW) > 2 || Math.abs(h - lastH) > 60) { lastW = w; lastH = h; build(); }
    }, 150);
  }).observe(stage);
  new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    if (visible) play(); else pause();
  }, { threshold: 0.02 }).observe(stage);
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); else play(); });

  lastW = stage.clientWidth; lastH = stage.clientHeight;
  build();
  play();
  if (coach && noHover) requestAnimationFrame(() => { coach = null; openHowto(false, 'First visit on a touch screen'); });
}
