// Renders the link-preview cards: og/<page>.jpg for each page, and og.jpg for the homepage.
//
//   node tools/og/render.mjs                  every page except the homepage
//   node tools/og/render.mjs about contact    just these pages
//   node tools/og/render.mjs home             the homepage card (overwrites og.jpg)
//
// Needs Google Chrome and Node 22 or later, on a Mac (sips makes the JPEGs).
// The About drawing and the robot dog are captured from the live site (BASE), so the robot
// shows the gait everyone has trained so far. The capture never posts gaits back. Each card
// is then drawn from tools/og/card.html in this checkout, which pulls its text and photos
// from the pages here. Bump the ?v= on the og:image tags after re-rendering a card.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = normalize(join(here, '..', '..'));
const build = join(here, 'build');
const outDir = process.env.OUT || root;
const BASE = (process.env.BASE || 'https://calebappleton.com').replace(/\/$/, '');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PAGES = ['about', 'companies', 'writing', 'adventures', 'robot-training', 'contact'];
const pages = process.argv.slice(2).length ? process.argv.slice(2) : PAGES;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- a small static server for this checkout ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = normalize(join(root, p));
  if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    const body = await readFile(f);
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch (_) { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const local = `http://127.0.0.1:${server.address().port}`;

/* ---------- headless Chrome over the DevTools protocol ---------- */
async function chrome() {
  const port = +(process.env.CDP_PORT || 9339);
  const profile = join(build, 'chrome');
  await mkdir(profile, { recursive: true });
  const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  let t;
  for (let i = 0; i < 50 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page'); } catch (_) {} }
  if (!t) { proc.kill(); throw new Error('Chrome did not start'); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0, waits = [];
  const pend = new Map();
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); return; }
    if (m.method === 'Fetch.requestPaused') {
      // Read the shared gaits, but never post this browser's training back to the site.
      const { requestId, request } = m.params;
      if (request.method === 'GET') send('Fetch.continueRequest', { requestId });
      else send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }
    if (m.method) { waits.filter(w => w.method === m.method).forEach(w => w.res(m)); waits = waits.filter(w => w.method !== m.method); }
  };
  const evaluate = async js => {
    const r = await send('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const goto = async url => { const loaded = new Promise(res => waits.push({ method: 'Page.loadEventFired', res })); await send('Page.navigate', { url }); await loaded; };
  const waitFor = async (js, ms = 30000) => {
    const t0 = Date.now();
    for (;;) { const v = await evaluate(js); if (v) return v; if (Date.now() - t0 > ms) throw new Error('Timed out waiting for ' + js.slice(0, 90)); await sleep(100); }
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/gait*' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "try { localStorage.setItem('calebappleton.howto.v1', '1'); localStorage.setItem('calebappleton.rig.mode', 'best'); } catch (_) {}" });
  return { send, evaluate, goto, waitFor, close: () => { ws.close(); proc.kill(); } };
}

async function size(cdp, width, height, transparent = false) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await cdp.send('Emulation.setDefaultBackgroundColorOverride', transparent ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {});
}

async function shoot(cdp, file, selector, crop = { top: 0, left: 0 }) {
  let params = { format: 'png' };
  if (selector) {
    const clip = await cdp.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(), t = r.height * ${crop.top}, l = r.width * ${crop.left}; return { x: r.x + scrollX + l, y: r.y + scrollY + t, width: r.width - l, height: r.height - t, scale: 1 }; })()`);
    params = { ...params, clip, captureBeyondViewport: true };
  }
  const s = await cdp.send('Page.captureScreenshot', params);
  await writeFile(file, Buffer.from(s.result.data, 'base64'));
}

/* ---------- drawings captured from the live site ---------- */
const CAPTURES = {
  // The exploded espresso machine, on a transparent background so the card can crop it.
  about: async cdp => {
    await size(cdp, 1400, 1000, true);
    await cdp.goto(`${BASE}/about/`);
    await cdp.evaluate("document.head.insertAdjacentHTML('beforeend', '<style>*{background:transparent !important}</style>')");
    await cdp.waitFor("document.getElementById('xv-out')?.textContent === '70%'", 20000);
    await sleep(600);
    await shoot(cdp, join(build, 'about.png'), '#xv');
  },
  // The robot dog partway through a replay of the best gait so far.
  'robot-training': async cdp => {
    await size(cdp, 1400, 1000);
    await cdp.goto(`${BASE}/robot-training/`);
    await cdp.waitFor(`(() => { const m = (document.querySelector('.rig-view svg')?.textContent || '').match(/t\\s*=\\s*([\\d.]+)\\s*s/); return !!m && +m[1] >= 5.5 && +m[1] <= 7.5; })()`, 45000);
    // Hide the clock and gait count in the corner (they go stale) and crop in on the dog.
    await cdp.evaluate(`document.head.insertAdjacentHTML('beforeend', '<style>.rig-view svg text[text-anchor="end"]{visibility:hidden !important}</style>')`);
    await sleep(100);
    await shoot(cdp, join(build, 'robot-training.png'), '.rig-view canvas', { top: 0.36, left: 0.3 });
  },
};

/* ---------- the homepage card: drive the arm to carry the espresso machine ---------- */
const DRIVE = `(async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const stage = document.getElementById('stage');
  if (!stage.classList.contains('is-live')) return 'workcell not live';
  const r = stage.getBoundingClientRect();
  const fire = (t, x, y) => stage.dispatchEvent(new PointerEvent(t, { bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerType: 'mouse', button: 0, pointerId: 1, isPrimary: true }));
  const dot = [...document.querySelectorAll('.stage-notes text.callout')].find(e => e.textContent === 'About').parentNode.querySelector('circle');
  const cx = +dot.getAttribute('cx'), cy = +dot.getAttribute('cy');
  const glide = async (pts, from, n = 14) => { let [px, py] = from; for (const [x, y] of pts) { for (let i = 1; i <= n; i++) { fire('pointermove', px + (x - px) * i / n, py + (y - py) * i / n); await sleep(45); } px = x; py = y; await sleep(300); } return [px, py]; };
  await glide([[r.width * 0.62, 30], [cx, 30], [cx, cy]], [r.width * 0.62, 120]);
  await sleep(700);
  fire('pointerdown', cx, cy + 6); await sleep(60); fire('pointerup', cx, cy + 6); await sleep(1300);
  const m = (document.querySelector('.stage-notes path[stroke-dasharray="6 4"]')?.getAttribute('d') || '').match(/M ([\\d.]+) ([\\d.]+) H ([\\d.]+)/);
  if (!m) return 'not holding';
  const tx = +m[1] + (+m[3] - +m[1]) * 0.16, ty = +m[2] + 14;
  await glide([[cx, cy - 40], [cx, 24], [tx, 24], [tx, ty]], [cx, cy], 40);
  await sleep(1600);
  return 'holding over the belt';
})()`;

async function card(cdp, page) {
  await size(cdp, 1200, 630);
  await cdp.goto(`${local}/tools/og/card.html?page=${page}`);
  const ready = await cdp.waitFor('window.__ready', 30000);
  if (ready !== true) throw new Error(`${page}: ${ready}`);
  if (page === 'home') { await sleep(4500); console.log('home:', await cdp.evaluate(DRIVE)); }
  else await sleep(400);
  const png = join(build, `${page}@2x.png`);
  await shoot(cdp, png);
  const out = page === 'home' ? join(outDir, 'og.jpg') : join(outDir, 'og', `${page}.jpg`);
  await mkdir(dirname(out), { recursive: true });
  execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-z', '630', '1200', png, '--out', out], { stdio: 'ignore' });
  console.log('wrote', out);
}

await mkdir(build, { recursive: true });
const cdp = await chrome();
try {
  for (const page of pages) {
    if (page !== 'home' && !PAGES.includes(page)) throw new Error(`Unknown page: ${page}`);
    if (CAPTURES[page]) await CAPTURES[page](cdp);
    await card(cdp, page);
  }
} finally {
  cdp.close();
  server.close();
}
