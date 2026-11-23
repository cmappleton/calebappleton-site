// Builds js/vendor/three.min.js: just the parts of three.js the site uses,
// tree-shaken and minified. The site has no build step; this runs by hand and
// its output is committed.
//
//   cd tools && npm install && npm run build:three
//
// Rerun it whenever a script in js/ starts using another three.js class or
// addon. It reads js/*.js to find what is used (THREE.Name, named imports from
// 'three', and named imports from 'three/addons/...'), bundles exactly those,
// and rewrites the importmap on every page that has one so each addon path the
// site imports points at the bundle too.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const OUT_URL = '/js/vendor/three.min.js';
const OUT_FILE = path.join(root, OUT_URL);
const THREE_PKG = path.join(here, 'node_modules', 'three');
const THREE_VERSION = JSON.parse(fs.readFileSync(path.join(THREE_PKG, 'package.json'), 'utf8')).version;

/* ---------- what the site uses ---------- */
const core = new Set();
const addons = new Map();          // 'three/addons/x.js' -> Set of names
const jsDir = path.join(root, 'js');
for (const f of fs.readdirSync(jsDir).filter(f => f.endsWith('.js'))) {
  const src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  for (const m of src.matchAll(/\bTHREE\.([A-Za-z_$][\w$]*)/g)) core.add(m[1]);
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"]three['"]/g)) names(m[1]).forEach(n => core.add(n));
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](three\/addons\/[^'"]+)['"]/g)) {
    if (!addons.has(m[2])) addons.set(m[2], new Set());
    names(m[1]).forEach(n => addons.get(m[2]).add(n));
  }
  if (/import\s+\*\s+as\s+\w+\s+from\s*['"]three\/addons\//.test(src) || /from\s*['"]three\/(?!addons\/)[^'"]+['"]/.test(src)) {
    fail(`${f}: import addons by name (import { X } from 'three/addons/...'); other forms are not supported by this bundle`);
  }
}
function names(list) {
  return list.split(',').map(s => s.trim()).filter(Boolean).map(s => {
    if (/\s+as\s+/.test(s)) fail(`renamed imports ("${s}") are not supported; import the plain name`);
    return s;
  });
}
function fail(msg) { console.error('build-three: ' + msg); process.exit(1); }

// Every name must really exist, or the page would only find out at run time.
const THREE = await import('three');
const missing = [...core].filter(n => !(n in THREE));
if (missing.length) fail(`not exported by three ${THREE_VERSION}: ${missing.join(', ')}`);
for (const [spec, set] of addons) {
  const mod = await import(spec.replace(/^three\/addons\//, 'three/examples/jsm/'));
  const gone = [...set].filter(n => !(n in mod));
  if (gone.length) fail(`not exported by ${spec}: ${gone.join(', ')}`);
}

/* ---------- bundle ---------- */
const entry = [
  `export { ${[...core].sort().join(', ')} } from 'three';`,
  ...[...addons].map(([spec, set]) => `export { ${[...set].sort().join(', ')} } from '${spec}';`)
].join('\n');

const result = await build({
  stdin: { contents: entry, resolveDir: here, sourcefile: 'three-entry.js' },
  bundle: true,
  format: 'esm',
  minify: true,
  // Import maps are needed to load the site's modules at all, so any browser
  // that runs this already has at least this much JavaScript.
  target: ['chrome89', 'edge89', 'firefox108', 'safari16.4'],
  legalComments: 'none',
  banner: { js: `/* three.js ${THREE_VERSION} (MIT License, Copyright 2010-2023 Three.js Authors), reduced to what calebappleton.com uses. Built by tools/build-three.mjs. */` },
  metafile: true,
  write: false,
  logLevel: 'warning',
  plugins: [{
    // Bundle from three's source modules rather than its prebuilt single file,
    // so unused classes drop out. Addons import 'three' too, which lands here,
    // so there is only ever one copy.
    name: 'three-src',
    setup(b) { b.onResolve({ filter: /^three$/ }, () => ({ path: path.join(THREE_PKG, 'src/Three.js') })); }
  }]
});

const inputs = Object.keys(result.metafile.inputs);
if (inputs.some(p => p.includes('build/three'))) fail('the prebuilt three.module.js slipped into the bundle');
const code = result.outputFiles[0].contents;
fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
fs.writeFileSync(OUT_FILE, code);

/* ---------- importmaps ---------- */
const imports = { three: OUT_URL };
for (const spec of [...addons.keys()].sort()) imports[spec] = OUT_URL;
const tag = `<script type="importmap">${JSON.stringify({ imports })}</script>`;
const pages = [];
const walk = dir => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'tools') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.html')) pages.push(p);
  }
};
walk(root);
const updated = [];
for (const p of pages) {
  const html = fs.readFileSync(p, 'utf8');
  if (!/<script type="importmap">/.test(html)) continue;
  const next = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, tag);
  if (next !== html) { fs.writeFileSync(p, next); updated.push(path.relative(root, p)); }
}

console.log(`three ${THREE_VERSION}: ${core.size} core exports, ${[...addons.values()].reduce((a, s) => a + s.size, 0)} from ${addons.size} addons`);
console.log(`wrote ${path.relative(root, OUT_FILE)} (${(code.length / 1024).toFixed(1)} KB)`);
console.log(updated.length ? `updated the importmap in ${updated.join(', ')}` : 'importmaps already up to date');
