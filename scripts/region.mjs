// The region bake: turns a district's OpenStreetMap data into the region map the viewer streams.
//   node region.mjs --id korosten [--overpass URL] [--tile 0.4] [--refresh]
//
// Reads regions/<id>/region.json (the checked-in source config: the OSM relation of the district,
// the grid step), writes regions/<id>/data/:
//   index.json      the always-loaded base: the district boundary, the big roads, the rivers, the rail,
//                   every settlement (name, kind, population, OSM id) — enough to draw the whole district
//   cNNNN.json      one file per grid tile: full roads (with bridges), streams, rail, forest polygons,
//                   water areas, building footprints, railway stations. Loaded lazily by viewport.
//   land.json       {box, rings} — the district boundary as land polygons (same shape as a trip's land.json)
//   borders.json    {lines}      — the same boundary as strokeable lines (same shape as a trip's borders.json)
//   neighbours.json {rings,names}— the surrounding districts' boundaries, simplified: the seam data for a
//                   future oblast view (each district carries its neighbours, so two adjacent districts
//                   agree on the border they share — it is the same OSM way)
//   landmarks.json  [{name, kind, ll, qid, tags, score, desc}] — named sights with a Wikidata id, ranked
//
// A region folder becomes a trip folder as soon as Phase 2 adds route.json (the ride): the viewer reads
// both through the same registry, and the formats follow trips/ukraine-loop/ (see REGIONS.md).
//
// Services (please respect their policies): Overpass API, one tile query at a time with a pause, mirrors
// if the main one is busy; Wikidata for landmark fame (CC0). Everything is cached in regions/<id>/.cache.
import { existsSync, readFileSync, copyFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { args, readJSON, writeJSON, politeFetch, simplify } from './lib.mjs';

const A = args(), ID = A.id;
if (!ID) { console.error('usage: node region.mjs --id korosten [--overpass URL] [--tile 0.4]'); process.exit(1); }
const ROOT = join(dirname(new URL(import.meta.url).pathname), '..'), RDIR = join(ROOT, 'regions', ID);
const CFG = readJSON(join(RDIR, 'region.json'));
if (!CFG) throw Error(`no regions/${ID}/region.json: a region needs a checked-in config (see REGIONS.md)`);
if (A['name-uk']) CFG.osm['name:uk'] = A['name-uk'];
const TILE = +(A.tile || CFG.tile || 0.4), OUT = join(RDIR, 'data'), CACHE = join(RDIR, '.cache');
const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- OpenStreetMap (Overpass)
const HOSTS = A.overpass ? [A.overpass] : ['https://lz4.overpass-api.de/api/interpreter', 'https://overpass-api.de/api/interpreter', 'https://z.overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
let usedHost = HOSTS[0];
async function overpass(q) {
  let err;
  for (let round = 0; round < 4; round++) { if (round) { console.error(`  every Overpass server is busy; waiting ${30 * round} s`); await new Promise(r => setTimeout(r, 30000 * round)); } for (const host of HOSTS) {
    try { const r = JSON.parse(await politeFetch(host, { method: 'POST', body: 'data=' + encodeURIComponent(q), cacheKey: 'overpass:' + q, alsoCachedAs: [...HOSTS], headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, cacheDir: join(CACHE, 'overpass'), gapMs: 3000, tries: 2, timeoutMs: 240000, accept: s => s.startsWith('{') })); usedHost = host; HOSTS.splice(HOSTS.indexOf(host), 1); HOSTS.unshift(host); return r; }
    catch (e) { err = e; console.error(`  overpass ${host}: ${e.message}`); }
  } }
  throw Error(`Overpass failed (${err?.message}). Rerun later (finished tiles are kept) or point --overpass at your own server.`);
}
// join relation members into closed rings (districts, forests and lakes are often relations)
function ringsOf(members, keepRole) {
  const segs = members.filter(m => m.geometry && keepRole(m.role)).map(m => m.geometry.map(g => [g.lon, g.lat])), out = [];
  while (segs.length) { let ring = segs.shift(), grown = true;
    while (grown && !(ring.length > 3 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1])) { grown = false;
      for (let k = 0; k < segs.length; k++) { const s = segs[k], e = ring.at(-1);
        if (s[0][0] === e[0] && s[0][1] === e[1]) ring = ring.concat(s.slice(1)); else if (s.at(-1)[0] === e[0] && s.at(-1)[1] === e[1]) ring = ring.concat(s.slice(0, -1).reverse()); else continue;
        segs.splice(k, 1); grown = true; break; } }
    if (ring.length > 3) out.push(ring); }
  return out;
}
const bboxOf = pts => { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const [x, y] of pts) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); } return [a, b, c, d]; };
const inRing = (pts, x, y) => { let r = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) r = !r; } return r; };
const centroidOf = pts => { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; };

// ---------------------------------------------------------------- 1. the district boundary
console.log(`region ${ID}: ${CFG.name} (OSM relation ${CFG.osm.relation})`);
const rel = await overpass(`[out:json][timeout:120];relation(${CFG.osm.relation});out geom;`);
if (!rel.elements.length) throw Error(`relation ${CFG.osm.relation} not found`);
const OUTER = ringsOf(rel.elements[0].members, r => r !== 'inner'), INNER = ringsOf(rel.elements[0].members, r => r === 'inner');
if (!OUTER.length) throw Error('the relation has no closed outer rings');
const inDistrict = (x, y) => { let inside = false; for (const r of OUTER) if (inRing(r, x, y)) inside = !inside; if (!inside) return false; for (const r of INNER) if (inRing(r, x, y)) inside = !inside; return inside; };
let [w0, s0, e0, n0] = bboxOf(OUTER.flat());
const bnd = [...OUTER, ...INNER].map(r => simplify(r, 120));   // the boundary, simplified to ~120 m (drawn at district scale)
[w0, s0, e0, n0] = bboxOf(bnd.flat());
console.log(`  boundary: ${(Math.hypot((e0 - w0) * 111320 * Math.cos((s0 + n0) / 2 * Math.PI / 180), (n0 - s0) * 110540) / 1000).toFixed(0)} km across, ${bnd.reduce((n, r) => n + r.length, 0)} points`);

// ---------------------------------------------------------------- 2. the grid
const NX = Math.max(1, Math.ceil((e0 - w0) / TILE)), NY = Math.max(1, Math.ceil((n0 - s0) / TILE)), NT = NX * NY;
console.log(`  grid: ${NX} x ${NY} tiles of ${TILE}° (${(TILE * 111320).toFixed(0)} x ${(TILE * 110540).toFixed(0)} km), ${NT} tiles`);

// ---------------------------------------------------------------- 3. one query per tile, the features clipped and split into the tile
const ROADS = { motorway: 0, trunk: 0, motorway_link: 0, trunk_link: 0, primary: 1, primary_link: 1, secondary: 1, secondary_link: 1, tertiary: 2, tertiary_link: 2, unclassified: 3, residential: 3, living_street: 3 };
const NM = t => t['name:uk'] || t.name || null;
const clipLine = (pts, [x0, y0, x1, y1]) => {   // a polyline cut to the runs inside the box (Liang-Barsky per segment)
  const out = []; let run = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1]; let t0 = 0, t1 = 1, dx = bx - ax, dy = by - ay, ok = true;
    for (const [p, q] of [[-dx, ax - x0], [dx, x1 - ax], [-dy, ay - y0], [dy, y1 - ay]]) {
      if (!p) { if (q < 0) { ok = false; break; } } else { const r = q / p; if (r < 0) { if (r > t0) t0 = r; } else if (r < t1) t1 = r; }
    }
    if (!ok) { run = null; continue; }
    const a = [ax + dx * t0, ay + dy * t0], b = [ax + dx * t1, ay + dy * t1];
    if (run && run.at(-1)[0] === ax && run.at(-1)[1] === ay) run.push(b); else { run = [a, b]; out.push(run); }
  }
  return out;
};
const places = new Map(), stationsAll = [];
for (let c = 0; c < NT; c++) {
  const file = join(OUT, `c${String(c).padStart(4, '0')}.json`);
  const i = c % NX, j = Math.floor(c / NX), lon0 = +(w0 + i * TILE).toFixed(6), lat0 = +(s0 + j * TILE).toFixed(6), lon1 = +(Math.min(e0, w0 + (i + 1) * TILE)).toFixed(6), lat1 = +(Math.min(n0, s0 + (j + 1) * TILE)).toFixed(6);
  const KX = Math.cos(lat0 * Math.PI / 180) * 111320, KY = 110540, M = 0.01;   // a small margin so roads that cross a tile edge are caught whole
  const box = [lon0, lat0, lon1, lat1], mBox = [lon0 - M, lat0 - M, lon1 + M, lat1 + M];
  const q = `[out:json][timeout:180][bbox:${mBox[1]},${mBox[0]},${mBox[3]},${mBox[2]}];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street)(_link)?$"];way["railway"="rail"];way["waterway"~"^(river|stream|canal)$"];way["landuse"="forest"];way["natural"="wood"];way["natural"="water"];relation["landuse"="forest"];relation["natural"="wood"];relation["natural"="water"];way["building"];node["railway"~"^(station|halt)$"];node["place"];);out geom;`;
  const osm = await overpass(q);
  // pass 1: place nodes and stations are collected globally (they are small; index.json carries them all)
  for (const e of osm.elements) { const t = e.tags || {};
    if (e.type === 'node' && t.place) { if (!NM(t)) continue; if (!places.has(e.id)) places.set(e.id, { name: NM(t), rank: t.place === 'city' ? 3 : t.place === 'town' ? 2 : /village/.test(t.place) ? 1 : /hamlet|locality|isolated_dwelling/.test(t.place) ? 0.5 : 0.2, ll: [+e.lon.toFixed(6), +e.lat.toFixed(6)], pop: +t.population || 0, osm: `n${e.id}` }); continue; }
    if (e.type === 'node' && (t.railway === 'station' || t.railway === 'halt') && NM(t)) stationsAll.push({ name: NM(t), ll: [+e.lon.toFixed(6), +e.lat.toFixed(6)] });
  }
  const toXY = ll => [Math.round((ll[0] - lon0) * KX), Math.round((ll[1] - lat0) * KY)];
  const ro = [], rv = [], ra = [], wa = [], fo = [], bd = [];
  const polyOf = e => e.type === 'relation' ? ringsOf(e.members, r => r === 'outer') : e.geometry && e.geometry.length > 3 && e.geometry[0].lon === e.geometry.at(-1).lon && e.geometry[0].lat === e.geometry.at(-1).lat ? [e.geometry.map(g => [g.lon, g.lat])] : [];
  for (const e of osm.elements) { const t = e.tags || {};
    if (e.type === 'node') continue;
    // a polygon (forest, water, building) belongs to the tile of its centroid, unsimplified except forests; a line is clipped into every tile it crosses
    if (e.type === 'relation' || (t.landuse === 'forest' || t.natural === 'wood' || t.natural === 'water' || t.building)) {
      let rings = polyOf(e); if (!rings.length && e.geometry) rings = [e.geometry.map(g => [g.lon, g.lat])];   // an unclosed way drawn as a ring if it closes, else its outline
      if (t.building && t.building === 'no') continue;
      for (let ring of rings) {
        const [cx, cy] = centroidOf(ring); if (cx < mBox[0] || cx > mBox[2] || cy < mBox[1] || cy > mBox[3]) continue;
        if (t.building) { if (!inDistrict(cx, cy)) continue; if (ring.length < 4) continue; bd.push(ring.map(p => toXY(p))); }
        else if (t.landuse === 'forest' || t.natural === 'wood') { if (!inDistrict(cx, cy)) continue; if (bboxOf(ring)[2] - bboxOf(ring)[0] < 1e-4 && bboxOf(ring)[3] - bboxOf(ring)[1] < 1e-4) continue; fo.push(simplify(ring, 20).map(p => toXY(p))); }
        else if (t.natural === 'water') { if (!inDistrict(cx, cy)) continue; wa.push(simplify(ring, 10).map(p => toXY(p))); }
      }
      continue;
    }
    if (!e.geometry) continue;
    const pts = simplify(e.geometry.map(g => [g.lon, g.lat]), 12); if (pts.length < 2) continue;
    if (t.highway) { const k = ROADS[t.highway]; if (k === undefined) continue; if (!pts.some(p => inDistrict(p[0], p[1]))) continue; for (const run of clipLine(pts, box)) if (run.length > 1) ro.push([k, t.bridge && t.bridge !== 'no' ? 1 : 0, run.map(p => toXY(p))]); }
    else if (t.railway === 'rail') { if (!pts.some(p => inDistrict(p[0], p[1]))) continue; for (const run of clipLine(pts, box)) if (run.length > 1) ra.push(run.map(p => toXY(p))); }
    else if (t.waterway) { const k = t.waterway === 'river' ? 0 : t.waterway === 'canal' ? 1 : 2; if (!pts.some(p => inDistrict(p[0], p[1]))) continue; for (const run of clipLine(pts, box)) if (run.length > 1) rv.push([k, k === 0 && NM(t) ? NM(t) : null, run.map(p => toXY(p))]); }
  }
  const st = stationsAll.filter(s => s.ll[0] >= lon0 && s.ll[0] <= lon1 && s.ll[1] >= lat0 && s.ll[1] <= lat1).map(s => [s.name, ...toXY(s.ll)]);
  writeJSON(file, { c, i, j, box, origin: [lon0, lat0], ro, rv, ra, wa, fo, st });   // the map tile: what shows from the second pinch in
  if (bd.length) writeJSON(join(OUT, `b${String(c).padStart(4, '0')}.json`), { c, origin: [lon0, lat0], bd });   // the buildings: deep-zoom data, loaded only when a house is a few pixels
  console.log(`  c${String(c).padStart(4, '0')} [${i},${j}]: ${ro.length} roads, ${ra.length} rail, ${rv.length} water, ${fo.length} forest, ${wa.length} water areas (${(statSync(file).size / 1024).toFixed(0)} KB${bd.length ? ` + b: ${bd.length} buildings (${(statSync(join(OUT, `b${String(c).padStart(4, '0')}.json`)).size / 1024).toFixed(0)} KB)` : ''})`);
}

// ---------------------------------------------------------------- 4. the neighbours: the districts around, simplified (the oblast-stitching seam data)
const nb = await overpass(`[out:json][timeout:120][bbox:${(s0 - 0.02).toFixed(4)},${(w0 - 0.02).toFixed(4)},${(n0 + 0.02).toFixed(4)},${(e0 + 0.02).toFixed(4)}];relation["boundary"="administrative"]["admin_level"="${CFG.osm.admin_level || 6}"];out geom;`);
const nbRings = [], nbNames = [];
for (const e of nb.elements) { if (e.id === CFG.osm.relation) continue; const t = e.tags || {}; const name = t['name:uk'] || t.name; if (!name) continue;
  const rings = ringsOf(e.members, r => r === 'outer'); if (!rings.length) continue;
  for (const r of rings) { const bb = bboxOf(r); if (bb[2] < w0 - 0.02 || bb[0] > e0 + 0.02 || bb[3] < s0 - 0.02 || bb[1] > n0 + 0.02) continue; nbRings.push(simplify(r, 400)); nbNames.push(name); } }
writeJSON(join(OUT, 'neighbours.json'), { rings: nbRings, names: nbNames });
console.log(`  neighbours: ${nbNames.length} rings (${[...new Set(nbNames)].join(', ')})`);

// ---------------------------------------------------------------- 5. the base layers (index.json): what shows before any tile loads
// one whole-district query for the big roads, the rivers and the rail, so a road that crosses many tiles is
// one line here, not a run per tile
const baseQ = await overpass(`[out:json][timeout:180][bbox:${s0},${w0},${n0},${e0}];(way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"];way["waterway"="river"];way["railway"="rail"];);out geom;`);
const BASE = { roads: [], rivers: [], rail: [] };
const lenOf = pts => { let n = 0; for (let i = 1; i < pts.length; i++) n += Math.hypot((pts[i][0] - pts[i - 1][0]) * Math.cos(pts[i][1] * Math.PI / 180) * 111320, (pts[i][1] - pts[i - 1][1]) * 110540); return n; };
for (const e of baseQ.elements) { if (e.type !== 'way' || !e.geometry) continue; const t = e.tags || {}, pts = e.geometry.map(g => [g.lon, g.lat]); if (!pts.some(p => inDistrict(p[0], p[1]))) continue;
  if (t.highway) { const s = simplify(pts, 100); if (!t.ref && lenOf(s) < 2000) continue; BASE.roads.push([ROADS[t.highway] ?? 1, t.ref || null, s]); }
  else if (t.waterway === 'river') { const s = simplify(pts, 150); if (!NM(t) && lenOf(s) < 3000) continue; BASE.rivers.push([NM(t), s]); }   // a named river however small, an unnamed one from 3 km
  else if (t.railway === 'rail') BASE.rail.push(simplify(pts, 120)); }
BASE.roads.sort((a, b) => a[0] - b[0]);

// ---------------------------------------------------------------- 6. landmarks: named sights inside the district
const POLY = simplify(bnd[0], 800).map(([lon, la]) => `${la.toFixed(4)} ${lon.toFixed(4)}`).join(' ');
const lm = await overpass(`[out:json][timeout:120];(nwr["tourism"~"^(attraction|artwork|museum|viewpoint|zoo|theme_park)$"]["name"](poly:"${POLY}");nwr["historic"~"^(monument|memorial|castle|ruins|fort|archaeological_site)$"]["name"](poly:"${POLY}");nwr["leisure"~"^(park|nature_reserve)$"]["name"](poly:"${POLY}");nwr["natural"~"^(beach|cave_entrance|rock)$"]["name"](poly:"${POLY}");nwr["man_made"~"^(watermill|windmill|tower|lighthouse)$"]["name"](poly:"${POLY}");nwr["waterway"~"^(dam|weir)$"]["name"](poly:"${POLY}"););out center tags;`);
const LMKIND = t => t.leisure === 'park' || t.leisure === 'nature_reserve' ? 'park' : t.tourism === 'museum' ? 'museum' : t.tourism === 'viewpoint' ? 'viewpoint' : t.tourism ? 'attraction' : /monument|memorial|statue/.test((t.historic || '') + (t.memorial || '')) ? 'monument' : /castle|fort|ruins/.test(t.historic || '') ? 'castle' : t.natural === 'cave_entrance' || t.natural === 'rock' ? 'rock' : t.natural === 'beach' ? 'beach' : /mill/.test(t.man_made || '') ? 'mill' : /tower|lighthouse/.test(t.man_made || '') ? 'tower' : t.waterway === 'dam' || t.waterway === 'weir' ? 'dam' : 'sight';
const byQ = new Map();
for (const e of lm.elements) { const t = e.tags || {}; const ll = e.type === 'node' ? [e.lon, e.lat] : e.center ? [e.center.lon, e.center.lat] : null; if (!ll || !inDistrict(ll[0], ll[1])) continue;
  const key = t.wikidata ? t.wikidata.split(';')[0] : NM(t) + '|' + ll.map(v => v.toFixed(3)); if (byQ.has(key)) continue;
  byQ.set(key, { name: NM(t), qid: t.wikidata ? t.wikidata.split(';')[0] : null, kind: LMKIND(t), ll: [+ll[0].toFixed(6), +ll[1].toFixed(6)], osm: `${e.type[0]}${e.id}`, tags: { tourism: t.tourism, historic: t.historic, leisure: t.leisure, natural: t.natural, man_made: t.man_made } }); }
const qids = [...byQ.keys()].filter(q => q[0] === 'Q');
const wd = {};
for (let i = 0; i < qids.length; i += 50) { try { const j = JSON.parse(await politeFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=sitelinks|descriptions&languages=en&ids=${qids.slice(i, i + 50).join('|')}`, { cacheDir: join(CACHE, 'wikidata'), gapMs: 1000, accept: s => s.startsWith('{') }));
  for (const [q, e] of Object.entries(j.entities || {})) wd[q] = { links: Object.keys(e.sitelinks || {}).length, desc: e.descriptions?.en?.value || '' }; } catch (e) { console.error('  wikidata:', e.message); } }
const landmarks = [...byQ.values()].map(l => ({ ...l, links: wd[l.qid]?.links ?? 0, desc: wd[l.qid]?.desc || '', score: +((1 + (wd[l.qid]?.links ?? 0)) * (l.kind === 'park' || l.kind === 'castle' || l.kind === 'museum' ? 2 : 1)).toFixed(2) })).sort((a, b) => b.score - a.score);
writeJSON(join(OUT, 'landmarks.json'), landmarks, true);
console.log(`  landmarks: ${landmarks.length} (top: ${landmarks.slice(0, 6).map(l => `${l.name} [${l.kind}]`).join('; ')})`);

// ---------------------------------------------------------------- 7. the files that mirror a trip's data folder
writeJSON(join(OUT, 'land.json'), { box: [+w0.toFixed(4), +s0.toFixed(4), +e0.toFixed(4), +n0.toFixed(4)], rings: bnd });
writeJSON(join(OUT, 'borders.json'), { lines: bnd.map(r => r.slice(0, -1)) });
if (existsSync(join(ROOT, 'trips/ukraine-loop/data/LICENSE'))) copyFileSync(join(ROOT, 'trips/ukraine-loop/data/LICENSE'), join(OUT, 'LICENSE'));
const placesArr = [...places.values()].filter(p => p.rank > 0.15 && inDistrict(p.ll[0], p.ll[1])).sort((a, b) => b.rank - a.rank || b.pop - a.pop);
const stationsArr = [...new Map(stationsAll.filter(s => inDistrict(s.ll[0], s.ll[1])).map(s => [s.name + '|' + s.ll.map(v => v.toFixed(2)), s])).values()];   // a station caught by two tiles' margin counts once
writeJSON(join(OUT, 'index.json'), {
  id: ID, name: CFG.name, name_en: CFG.name_en || null, oblast: CFG.oblast || null, country: CFG.country || 'Україна',
  box: [+w0.toFixed(4), +s0.toFixed(4), +e0.toFixed(4), +n0.toFixed(4)], grid: { nx: NX, ny: NY, tile: TILE }, tiles: NT,
  source: { overpass: usedHost, date: TODAY, data: 'OpenStreetMap (ODbL)', licence: 'https://www.openstreetmap.org/copyright' },
  bnd, base: BASE, places: placesArr.map(p => [p.name, p.rank, p.ll, p.pop, p.osm]),
  stations: stationsArr.map(s => [s.name, s.ll]),
  credits: ['Map data © OpenStreetMap contributors (ODbL), openstreetmap.org/copyright', 'Landmarks: Wikidata (CC0)'],
}, true);

// ---------------------------------------------------------------- 8. the registry: one entry per region, the viewer reads this
const regFile = join(ROOT, 'regions/registry.json'), reg = readJSON(regFile) || { regions: [] };
const entry = { id: ID, name: CFG.name, name_en: CFG.name_en || null, oblast: CFG.oblast || null, path: `regions/${ID}`, box: [+w0.toFixed(4), +s0.toFixed(4), +e0.toFixed(4), +n0.toFixed(4)], generated: TODAY, source: `OpenStreetMap via Overpass (${usedHost}), ${TODAY}` };
const at = reg.regions.findIndex(r => r.id === ID); if (at >= 0) reg.regions[at] = entry; else reg.regions.push(entry);
writeJSON(regFile, reg, true);
const total = NT ? [...Array(NT).keys()].reduce((n, c) => { for (const p of ['c', 'b']) { const f = join(OUT, `${p}${String(c).padStart(4, '0')}.json`); if (existsSync(f)) n += statSync(f).size; } return n; }, 0) : 0;
console.log(`index.json: ${(statSync(join(OUT, 'index.json')).size / 1024).toFixed(0)} KB, ${placesArr.length} places, ${stationsArr.length} stations; ${NT} tiles (+ their buildings), ${(total / 1024 / 1024).toFixed(2)} MB of tile data; registry: regions/registry.json (${reg.regions.length} region${reg.regions.length === 1 ? '' : 's'})`);
