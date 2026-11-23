/* Loads a page in headless Chromium over the DevTools protocol, waits, then prints what the
   Robot training readouts show, every page error, and the API calls the page made.
     node test/browser-check.js <url> [--wait 12] [--screenshot out.png] [--eval "js"] [--hide]
   --hide fires the page's pagehide handlers before reading, to check the closing report.
   Set CHROME to a Chromium or Chrome binary; the default is Playwright's cached headless shell. */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : (process.argv[i + 1] ?? true); };
const WAIT = Number(arg('wait', 12)), SHOT = arg('screenshot', null), EXTRA = arg('eval', null), HIDE = process.argv.includes('--hide');

function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dir = readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().pop();
  return join(cache, dir, 'chrome-mac', 'headless_shell');
}

const profile = await mkdtemp(join(tmpdir(), 'gait-check-'));
const chrome = spawn(findChrome(), ['--headless', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1280,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const port = await new Promise((resolve, reject) => {
  let buf = '';
  chrome.stderr.on('data', d => { buf += d; const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//); if (m) resolve(m[1]); });
  setTimeout(() => reject(new Error('Chromium did not start')), 15000);
});
const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map(), problems = [], calls = [];
ws.addEventListener('message', ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) problems.push(`console.${m.params.type}: ` + m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') problems.push('log: ' + m.params.entry.text + (m.params.entry.url ? ` (${m.params.entry.url})` : ''));
  if (m.method === 'Network.requestWillBeSent' && m.params.request.url.includes('/api/')) calls.push(`${m.params.request.method} ${new URL(m.params.request.url).pathname}`);
  if (m.method === 'Network.responseReceived' && m.params.response.url.includes('/api/')) calls.push(`  <- ${m.params.response.status}`);
});
const send = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async expr => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result?.result?.value;

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
await send('Page.navigate', { url });
await new Promise(r => setTimeout(r, WAIT * 1000));
if (HIDE) { await evaluate(`window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); true`); await new Promise(r => setTimeout(r, 1500)); }

const state = await evaluate(`(() => {
  const t = id => { const el = document.getElementById(id); return el ? (el.closest('div') && el.closest('div').hidden ? '(hidden) ' : '') + el.textContent : null; };
  let share = null; try { share = JSON.parse(localStorage.getItem('calebappleton.gait.share')); } catch (_) {}
  let local = null; try { const d = JSON.parse(localStorage.getItem('calebappleton.gait.v2')); local = d && { gen: d.gen, tried: d.tried, best: d.elites[0] && d.elites[0].f }; } catch (_) {}
  return { generation: t('rig-gen'), best: t('rig-best'), tried: t('rig-tried'), time: t('rig-time'), visitors: t('rig-visitors'), mine: t('rig-mine'),
    canvas: !!document.querySelector('#rig-canvas'), overlay: (document.querySelector('.rig-view svg') || {}).textContent || '', share, local };
})()`);
const extra = EXTRA ? await evaluate(EXTRA) : undefined;
if (SHOT) { const s = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(SHOT, Buffer.from(s.result.data, 'base64')); }

console.log(JSON.stringify({ url, state, extra, apiCalls: calls, problems }, null, 2));
ws.close(); chrome.kill();
await rm(profile, { recursive: true, force: true }).catch(() => {});
