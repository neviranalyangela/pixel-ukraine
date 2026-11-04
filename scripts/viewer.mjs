// Step 4: put the viewer into the trip folder (and optionally serve it).
//   node viewer.mjs --trip TRIP [--serve 8080]
// The trip folder is then a static site: index.html, road.js, layout.js, fonts/, sfx/, data/, art/. Host it anywhere static
// files are served (not .cache/, art/raw/ or art/ledger.json).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join, dirname, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { args, readJSON } from './lib.mjs';

export function install(TRIP) {
  if (!existsSync(join(TRIP, 'data/index.json'))) throw Error('no data/index.json: run bake.mjs first');
  if (!existsSync(join(TRIP, 'art/kit.json'))) console.warn('no art/kit.json yet: run plan-art.mjs and placeholder-art.mjs (free); the viewer will draw without pictures');
  const T = join(dirname(fileURLToPath(import.meta.url)), '../templates'), ROOT = join(T, '..');
  const site = existsSync(join(TRIP, 'site.json')) ? JSON.parse(readFileSync(join(TRIP, 'site.json'), 'utf8')) : {};   // optional trip settings: "support": "https://…" puts a donation link on the start card and in the dock; "posthog": "phc_…" (and optional "posthog_host") turns on PostHog; "vote": true shows the city vote (it needs the Worker's /api/votes)
  const ph = typeof site.posthog === 'string' && /^ph[a-z]_[A-Za-z0-9]+$/.test(site.posthog) ? { key: site.posthog, host: /^https:\/\/[^\s"'<>]+$/.test(site.posthog_host || '') ? site.posthog_host.replace(/\/$/, '') : undefined } : {};   // PostHog only with a project key in site.json ({"posthog": "phc_…"}); no key, no analytics
  const { posthog, posthog_host, ...pub } = site, js = o => JSON.stringify(o).replace(/</g, '\\u003c');
  writeFileSync(join(TRIP, 'index.html'), readFileSync(join(T, 'viewer.html'), 'utf8').replace('/*PH*/{}/*/PH*/', () => js(ph)).replace('/*SITE*/{}/*/SITE*/', () => js(pub)).replace('/*VOTE*/false/*/VOTE*/', () => js(site.vote === true)).replace('/*SUP*/false/*/SUP*/', () => js(/^https:\/\//.test(site.support || '')))); copyFileSync(join(T, 'road.js'), join(TRIP, 'road.js')); copyFileSync(join(T, 'layout.js'), join(TRIP, 'layout.js'));
  if (existsSync(join(T, 'regionmap.js'))) copyFileSync(join(T, 'regionmap.js'), join(TRIP, 'regionmap.js'));   // the region overview map screen: it reads regions/registry.json, so no regions means it stays asleep
  if (existsSync(join(ROOT, 'regions/registry.json'))) {   // the regions (district maps): a folder of baked data plus one registry entry each (REGIONS.md)
    const dst = join(TRIP, 'regions'); mkdirSync(dst, { recursive: true });
    const cp = (src, rel) => { for (const f of readdirSync(src)) { const s = join(src, f), d = join(dst, rel ? join(rel, f) : f); if (/^(\.cache|\.)/.test(f) && f !== '.assetsignore') continue; if (statSync(s).isDirectory()) { mkdirSync(d, { recursive: true }); cp(s, rel ? join(rel, f) : f); } else copyFileSync(s, d); } };
    cp(ROOT + '/regions', ''); console.log(`viewer: regions/ copied into ${join(TRIP, 'regions')} (the district maps)`);
  }
  {   // trips.json: the other trips this site carries, with a path relative to this build's own folder. The landing and the
      // region map read it (a missing file = a single-trip site: no links). The loop is the site's front page ('' at the
      // site root); every other trip is a folder named after its trips/ directory. site.json's "id" says which one this is.
    const TDIR = join(ROOT, 'trips'), ME = site.id || 'ukraine-loop';
    if (existsSync(TDIR)) {
      const sitePath = id => (id === 'ukraine-loop' ? '' : id + '/'), up = sitePath(ME).split('/').filter(Boolean).length, others = [];
      for (const id of readdirSync(TDIR)) { if (id === ME || !existsSync(join(TDIR, id, 'route.json'))) continue;
        const st = existsSync(join(TDIR, id, 'site.json')) ? JSON.parse(readFileSync(join(TDIR, id, 'site.json'), 'utf8')) : {};
        const r = readJSON(join(TDIR, id, 'route.json')) || {};
        others.push({ id, title: st.title || (r.from && r.to ? `${r.from.split(',')[0]} → ${r.to.split(',')[0]}` : id), path: (up ? '../'.repeat(up) : '') + sitePath(id) });
      }
      if (others.length) { writeFileSync(join(TRIP, 'trips.json'), JSON.stringify(others)); console.log(`viewer: trips.json — ${others.map(t => t.id).join(', ')} linked from this build`); }
    }
  }
  mkdirSync(join(TRIP, 'fonts'), { recursive: true }); for (const f of readdirSync(join(T, 'fonts'))) copyFileSync(join(T, 'fonts', f), join(TRIP, 'fonts', f));   // the self-hosted fonts and their licence (OFL.txt)
  mkdirSync(join(TRIP, 'sfx'), { recursive: true }); for (const f of readdirSync(join(T, 'sfx'))) if (f.endsWith('.mp3')) copyFileSync(join(T, 'sfx', f), join(TRIP, 'sfx', f));   // the sound loops: engines, steps, wind, city and country
}
export function serve(TRIP, port = 0) {   // a tiny static server (any other static server works too); dot-folders stay private
  const root = resolve(TRIP), TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.js': 'text/javascript', '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8' };
  const srv = createServer((req, res) => {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, ''); let f = join(root, p || 'index.html');
    if (!f.startsWith(root) || /[/\\]\./.test(f.slice(root.length)) || /[/\\]raw[/\\]|ledger\.json$/.test(f.slice(root.length))) { res.writeHead(404); return res.end('not found'); }
    if (existsSync(f) && statSync(f).isDirectory()) f = join(f, 'index.html'); if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(readFileSync(f));
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok({ srv, port: srv.address().port })));
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const A = args(), TRIP = A.trip; if (!TRIP) { console.error('usage: node viewer.mjs --trip TRIP [--serve PORT]'); process.exit(1); }
  install(TRIP); console.log(`viewer: ${join(TRIP, 'index.html')}`);
  if (A.serve) { const { port } = await serve(TRIP, A.serve === true ? 8080 : +A.serve); console.log(`open http://127.0.0.1:${port}/  (Ctrl+C to stop)`); }
}
