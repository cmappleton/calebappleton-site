/* Local preview of the site with the shared-training API, no credentials needed.
     node test/serve.js [--port 8787] [--api memory|off|down] [--seed]
   --api memory  runs api/gait.js on an in-memory store (the default)
   --api off     no API at all: /api/gait/ is a 404, like a plain static server
   --api down    the API answers 503, as it does on Vercel before the store is connected
   --seed        starts the memory store with a few good gaits and some totals */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle } from '../api/gait.js';
import { memRedis } from './memredis.js';
import { fingerprint } from './fingerprint.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? dflt : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true); };
const PORT = Number(arg('port', 8787)), MODE = arg('api', 'memory');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };

const mem = memRedis();
const store = MODE === 'memory' ? { redis: mem, salt: 'local' } : null;

if (MODE === 'memory' && arg('seed', false)) {
  const { bestGait } = fingerprint();
  const ip = n => ({ 'x-real-ip': `127.0.0.${n}`, 'Content-Type': 'application/json' });
  await handle(new Request('http://local/api/gait/', { method: 'POST', headers: ip(1), body: JSON.stringify({ id: 'seedvisitor1', tried: 4200, gen: 280, ms: 330000, g: bestGait }) }), store);
  await handle(new Request('http://local/api/gait/', { method: 'POST', headers: ip(2), body: JSON.stringify({ id: 'seedvisitor2', tried: 900, gen: 60, ms: 70000 }) }), store);
  console.log('seeded the store with a gait scoring', bestGait && (await (await handle(new Request('http://local/api/gait/'), store)).json()).elites[0].f);
}

async function api(req, res) {
  if (MODE === 'off') { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') { const chunks = []; for await (const c of req) chunks.push(c); body = Buffer.concat(chunks); }
  const headers = { ...req.headers, 'x-real-ip': req.socket.remoteAddress };
  const out = await handle(new Request(`http://localhost:${PORT}${req.url}`, { method: req.method, headers, body }), store);
  const text = await out.text();
  let note = '';
  if (req.method === 'POST') { try { const b = JSON.parse(body); note = ` id=${b.id} tried=${b.tried} gen=${b.gen} ms=${b.ms}${b.g ? ' +gait' : ''}`; } catch (_) {} }
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${req.url} -> ${out.status}${note}`);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(text);
}

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (path === '/api/gait' || path === '/api/gait/') return api(req, res);
  let file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT) || /(^|\/)(\.|api\/|node_modules)/.test(path.slice(1))) { res.writeHead(404); return res.end(); }
  try {
    const s = await stat(file);
    if (s.isDirectory()) {
      if (!path.endsWith('/')) { res.writeHead(308, { Location: path + '/' }); return res.end(); }   // like trailingSlash: true
      file = join(file, 'index.html');
    }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await readFile(join(ROOT, '404.html')).catch(() => 'Not found'));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://127.0.0.1:${PORT}/robot-training/  (api: ${MODE})`));
