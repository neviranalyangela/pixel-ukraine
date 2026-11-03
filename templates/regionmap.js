// The region map: a zoomable pixel overview of one district, as a screen of its own over the game.
//   regions/registry.json lists the regions; regions/<id>/data/ holds the baked map (scripts/region.mjs).
// This module is region-agnostic: every line, label and marker comes from the registry and the data
// files, so a new district is a data folder plus one registry entry (see REGIONS.md).
//
// What it draws, all from OpenStreetMap: the district boundary and its neighbours (the seam data for a
// future oblast view), the rivers, the railways, the roads down to street level, the forests, the lakes,
// building footprints in the towns, railway stations, and the settlements and landmarks with their names.
// index.json (the base: boundary, big roads, rivers, rail, every place) loads first and the district
// paints at once; the tiles (data/cNNNN.json, one per grid cell) stream in as they come into view and
// add the detail. Pinch or the wheel zooms, drag pans, a tap on a place, station or landmark opens a
// small card with its name, kind and links; the card and the buttons sit within thumb reach in portrait
// and landscape alike, and the mouse and the keyboard (drag, wheel, K, Esc) keep working on a desktop.
//
// The style is the game's own: a low-resolution canvas blown up without smoothing (like the country
// overview), the day palette of the corner minimap, the game's fonts. No new art, no dependencies.
export function createRegionMap(hooks = {}) {
  const $ = id => document.getElementById(id);   // every id here is unique in the page
  let booted = null, booting = null;   // booted: {list, dom, ...} once the registry has been read
  const params = new URLSearchParams(location.search);

  // ------------------------------------------------------------ the DOM, built once, on first open
  function build() {
    const st = document.createElement('style'); st.textContent = `
    #reg { position: fixed; inset: 0; z-index: 50; display: none; background: rgba(0,0,0,.55); font-family: 'Roboto Condensed', 'Arial Narrow', sans-serif; }
    #reg.open { display: flex; align-items: center; justify-content: center; }
    #regwrap { position: relative; touch-action: none; cursor: crosshair; }
    #regc { display: block; border-radius: 12px; border: 2px solid rgba(0,0,0,.6); box-shadow: 0 0 0 1px rgba(255,255,255,.14), 0 12px 40px rgba(0,0,0,.6); background: #d6cdb6; image-rendering: pixelated; }
    #regtools { position: absolute; right: 10px; top: 10px; display: flex; gap: 6px; }
    #regtools button { font: 700 12px/1 'Roboto Condensed', sans-serif; letter-spacing: .1em; text-transform: uppercase; color: #f3ecd8; background: rgba(30,24,16,.78); border: 1px solid rgba(0,0,0,.5); border-radius: 14px; padding: 7px 12px; cursor: pointer; }
    #regzoom { position: absolute; right: 10px; bottom: 10px; display: flex; flex-direction: column; gap: 6px; }
    #regzoom button { width: 36px; height: 36px; border-radius: 8px; border: 1px solid rgba(0,0,0,.5); background: rgba(236,227,201,.92); color: #1b1611; font: 700 22px/1 'Oswald', sans-serif; cursor: pointer; touch-action: manipulation; }
    #regback { position: absolute; left: 10px; top: 10px; display: flex; gap: 6px; align-items: baseline; pointer-events: none; }
    #regname { font: 700 26px 'Oswald', sans-serif; letter-spacing: .02em; text-transform: uppercase; color: rgba(30,24,16,.8); text-shadow: 0 1px 2px rgba(255,255,255,.3); }
    #regscale { position: absolute; left: 12px; bottom: 10px; pointer-events: none; color: rgba(30,24,16,.75); font: 700 11px 'Roboto Condensed', sans-serif; letter-spacing: .06em; text-transform: uppercase; }
    #regscale i { display: block; height: 4px; border: 1px solid rgba(30,24,16,.8); border-top: 0; margin-top: 2px; }
    #regcred { position: absolute; right: 10px; bottom: -20px; pointer-events: none; font: 9px ui-monospace, monospace; color: rgba(255,255,255,.6); }
    #regcred a { color: inherit; }
    #regcard { position: absolute; left: 50%; transform: translateX(-50%); bottom: -8px; max-width: min(92%, 400px); background: rgba(236,227,201,.96); border: 1px solid rgba(0,0,0,.5); border-radius: 8px; box-shadow: 0 8px 24px rgba(0,0,0,.45); color: #1b1611; padding: 10px 34px 10px 14px; display: none; }
    #regcard.on { display: block; }
    #regcard h3 { margin: 0; font: 700 20px/1.1 'Oswald', sans-serif; letter-spacing: .02em; }
    #regcard p { margin: 3px 0 0; font-size: 13px; line-height: 1.35; }
    #regcard small { display: block; margin-top: 5px; font-size: 10px; letter-spacing: .05em; text-transform: uppercase; color: #6d5f46; }
    #regcard a { color: #1d5fa8; }
    #regcard x { position: absolute; right: 6px; top: 4px; width: 26px; height: 26px; text-align: center; line-height: 24px; font: 700 16px sans-serif; cursor: pointer; border-radius: 4px; }
    #regcard x:hover { background: rgba(0,0,0,.12); }
    #regpick { position: absolute; inset: 0; background: rgba(10,8,6,.72); display: none; align-items: center; justify-content: center; border-radius: 12px; }
    #regpick.on { display: flex; }
    #regpick > div { background: #fbf8f0; border: 1px solid rgba(0,0,0,.5); border-radius: 10px; padding: 16px; min-width: 220px; max-width: 320px; }
    #regpick h3 { margin: 0 0 10px; font: 500 13px/1 'Oswald', sans-serif; letter-spacing: .14em; text-transform: uppercase; color: #6d5f46; }
    #regpick button { display: block; width: 100%; text-align: left; margin: 4px 0; font: 700 16px/1.2 'Roboto Condensed', sans-serif; color: #1b1611; background: rgba(0,0,0,.05); border: 1px solid rgba(0,0,0,.15); border-radius: 6px; padding: 10px 12px; cursor: pointer; }
    #regpick button small { display: block; font-size: 11px; font-weight: 400; color: #6d5f46; text-transform: uppercase; letter-spacing: .06em; }
    #regpick button:hover { background: rgba(0,0,0,.12); }
    @media (orientation: landscape) { #regcard { left: 10px; transform: none; bottom: 10px; } #regscale { bottom: 10px; left: auto; right: 60px; } }
    @media (max-width: 760px) { #regtools button { padding: 6px 8px; font-size: 10px; } #regzoom button { width: 32px; height: 32px; font-size: 20px; } #regname { font-size: 18px; } #regcred { font-size: 8px; bottom: -16px; } }
    @media (max-width: 760px) and (orientation: portrait) { #regtools { top: auto; bottom: calc(100% + 10px); right: 0; } #regback { top: auto; bottom: calc(100% + 10px); } }   /* an upright phone: the buttons sit above the map, clear of the card */
    body.reg #hud, body.reg #toasts, body.reg #station, body.reg #radio, body.reg #party, body.reg #chat, body.reg #chatin, body.reg #chatmode, body.reg #pedals, body.reg #roster { display: none !important; }   /* the region map owns the screen */
    `;
    document.head.appendChild(st);
    const reg = document.createElement('div'); reg.id = 'reg';
    reg.innerHTML = `<div id="regwrap"><canvas id="regc"></canvas>
      <div id="regback"><span id="regname"></span></div>
      <div id="regtools"><button id="regride" type="button" hidden>Поїхати</button><button id="regpickb" type="button" hidden>Райони</button><button id="regclose" type="button">Закрити</button></div>
      <div id="regzoom"><button id="regplus" type="button">+</button><button id="regminus" type="button">−</button></div>
      <div id="regscale"><span></span><i></i></div>
      <div id="regcred">Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors (ODbL)</div>
      <div id="regcard"><x aria-label="закрити">✕</x><h3></h3><p></p><small></small></div>
      <div id="regpick"><div><h3>Райони</h3><div id="regpickl"></div></div></div>
    </div>`;
    document.body.appendChild(reg);
    return reg;
  }

  async function boot() {
    if (booted) return booted;
    if (!booting) booting = (async () => {
      const list = await fetch('regions/registry.json', { cache: 'force-cache' }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (!list || !Array.isArray(list.regions) || !list.regions.length) return null;
      const dom = build();
      return { list: list.regions, dom, cur: null, tiles: new Map(), pending: 0 };
    })();
    return booted = await booting;
  }

  // ------------------------------------------------------------ the state of the open map
  // B: [lon,lat] -> map pixels at zoom 1 (equirectangular, x squeezed by cos(lat), y up is north).
  // Z: {k, tx, ty} — zoom and pan in map pixels; T(p) = p*k + t, like the country overview.
  let B = null, Z = null, LW = 0, LH = 0, IDX = null, LMS = null, NBR = null, CACHED = null, tiles = new Map(), btiles = new Map(), pending = 0, R = null, pickOpen = false, TRIPS = null;   // TRIPS: trips.json (the site's other trips), for a region's «Поїхати» link

  function rideLink(trip) {   // where a region's ride lives: its id among this site's trips (viewer.mjs writes trips.json per build)
    if (!trip) return null;
    const p = TRIPS && TRIPS.find(t => t.id === trip);
    return p ? p.path : null;
  }
  function trips() {   // loaded once, on first open; a single-trip site has no file
    if (TRIPS) return Promise.resolve();
    return fetch('trips.json').then(r => r.ok ? r.json() : null).then(j => { TRIPS = Array.isArray(j) ? j : []; }).catch(() => { TRIPS = []; });
  }

  function fit() {   // the canvas keeps the district's own aspect, fitted into the viewport either way up
    if (!R) return;
    const vw = Math.min(innerWidth, Math.max(320, innerWidth * .94)), vh = Math.max(200, innerHeight - 64), ar = LW / LH;
    let w = Math.min(vw, 1100), h = w / ar;
    if (h > vh) { h = vh; w = h * ar; }
    if (w > vw) { w = vw; h = w / ar; }
    R.c.style.width = `${Math.round(w)}px`; R.c.style.height = `${Math.round(h)}px`;
    size(w, h);
  }
  function size(cssW, cssH) { const c = R.c, dpr = Math.min(2, devicePixelRatio || 1); c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr); }

  function project(idx) {   // the projection and the low-res canvas for one region
    const pts = (idx.bnd || []).flat().length ? idx.bnd.flat() : [[idx.box[0], idx.box[1]], [idx.box[2], idx.box[3]]];
    let a0 = 1e9, b0 = 1e9, a1 = -1e9, b1 = -1e9; for (const [lon, la] of pts) { a0 = Math.min(a0, lon); a1 = Math.max(a1, lon); b0 = Math.min(b0, la); b1 = Math.max(b1, la); }
    const kx = Math.cos((b0 + b1) / 2 * Math.PI / 180), pad = 14;
    LW = Math.max(160, Math.min(360, Math.round(Math.max((a1 - a0) * kx, b1 - b0) * 220)));
    LH = Math.round(LW / Math.max(.35, Math.min(2.8, (a1 - a0) * kx / (b1 - b0))));
    const sc = Math.min((LW - 2 * pad) / ((a1 - a0) * kx), (LH - 2 * pad) / (b1 - b0)), ox = (LW - (a1 - a0) * kx * sc) / 2, oy = (LH - (b1 - b0) * sc) / 2;
    B = ([lon, la]) => [ox + (lon - a0) * kx * sc, LH - oy - (la - b0) * sc];
    Z = { k: 1, tx: 0, ty: 0 };
  }

  const clamp = () => { Z.k = Math.max(1, Math.min(64, Z.k)); Z.tx = Math.min(0, Math.max(LW - LW * Z.k, Z.tx)); Z.ty = Math.min(0, Math.max(LH - LH * Z.k, Z.ty)); };
  const T = p => [p[0] * Z.k + Z.tx, p[1] * Z.k + Z.ty];
  const zoom = (f, cx, cy) => { const k0 = Z.k; Z.k = Math.max(1, Math.min(64, Z.k * f)); const r = Z.k / k0; Z.tx = cx - (cx - Z.tx) * r; Z.ty = cy - (cy - Z.ty) * r; clamp(); loadTiles(); draw(); };

  // ------------------------------------------------------------ the tiles, loaded by viewport
  function tileBox(t) { const [x0, y0] = B([t.box[0], t.box[3]]), [x1, y1] = B([t.box[2], t.box[1]]); return [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]; }
  function visible(bb) { const vx0 = -Z.tx / Z.k, vy0 = -Z.ty / Z.k; return bb[2] > vx0 && bb[0] < vx0 + LW / Z.k && bb[3] > vy0 && bb[1] < vy0 + LH / Z.k; }
  function loadTiles() {
    if (!IDX || !IDX.grid || Z.k < 2) return;   // the base layer is the whole district; the tiles (forests, streets) come with the first pinch
    const g = IDX.grid;
    const want = (c, Map2, pre) => { if (!Map2.has(c)) { Map2.set(c, null);
        pending++; fetch(`${R.path}/data/${pre}${String(c).padStart(4, '0')}.json`).then(r => r.ok ? r.json() : null).then(d => { Map2.set(c, prep(d)); }).catch(() => Map2.delete(c)).finally(() => { pending--; if (R.open) draw(); }); } };
    for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) { const c = j * g.nx + i, lon0 = IDX.box[0] + i * g.tile, lat0 = IDX.box[1] + j * g.tile, lon1 = Math.min(IDX.box[2], lon0 + g.tile), lat1 = Math.min(IDX.box[3], lat0 + g.tile);
      if (!visible(tileBox({ box: [lon0, lat0, lon1, lat1] }))) continue;
      want(c, tiles, 'c');
      if (Z.k >= 16) want(c, btiles, 'b');   // the buildings: deep-zoom data, only when a house is about to be a few pixels
    }
  }
  function prep(d) {   // one pass: metres-from-origin -> map pixels, plus a bbox per feature for the viewport cull
    if (!d) return null;
    const KX = Math.cos(d.origin[1] * Math.PI / 180) * 111320, KY = 110540, toB = p => B([d.origin[0] + p[0] / KX, d.origin[1] + p[1] / KY]);
    const lines = a => a.map(pts => { const q = pts.map(toB); return { p: q, bb: bbox(q) }; });
    const polys = a => a.map(ring => { const q = ring.map(toB); return { p: q, bb: bbox(q) }; });
    if (Array.isArray(d.bd)) return { bd: polys(d.bd) };   // a b-file: buildings only
    return { ro: (d.ro || []).map(([cls, br, pts]) => { const q = pts.map(toB); return { cls, br, p: q, bb: bbox(q) }; }), rv: (d.rv || []).map(([k, n, pts]) => { const q = pts.map(toB); return { k, n, p: q, bb: bbox(q) }; }), ra: lines(d.ra || []), wa: polys(d.wa || []), fo: polys(d.fo || []), st: (d.st || []).map(([n, x, y]) => { const q = toB([x, y]); return { n, p: q, bb: [q[0] - 1, q[1] - 1, q[0] + 1, q[1] + 1] }; }) };
  }
  const bbox = q => { let a = 1e9, b = 1e9, c = -1e9, e = -1e9; for (const [x, y] of q) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); e = Math.max(e, y); } return [a, b, c, e]; };

  // ------------------------------------------------------------ drawing
  function draw() {
    if (!R || !R.open || !B || !CACHED) return;
    const { c, lo } = R, g = lo.getContext('2d'), x = c.getContext('2d'), k = Z.k;
    g.fillStyle = '#cfc6ae'; g.fillRect(0, 0, LW, LH);   // the neighbours' land: muted, out of play
    const path = (pts, close) => { g.beginPath(); pts.forEach((p, i) => { const [px, py] = T(p); i ? g.lineTo(px, py) : g.moveTo(px, py); }); if (close) g.closePath(); };
    const rings = rs => { g.beginPath(); for (const r of rs) r.forEach((p, i) => { const [px, py] = T(p); i ? g.lineTo(px, py) : g.moveTo(px, py); }), g.closePath(); };
    g.lineJoin = 'round'; g.lineCap = 'round';
    for (const r of CACHED.nbr) { path(r, true); g.fillStyle = '#c4bba3'; g.fill(); g.strokeStyle = '#b0a68d'; g.lineWidth = 1; g.stroke(); }
    if (CACHED.bnd.length) { rings(CACHED.bnd); g.fillStyle = '#ece3c9'; g.fill(); }
    const vis = bb => { const vx0 = -Z.tx / Z.k, vy0 = -Z.ty / Z.k; return bb[2] > vx0 && bb[0] < vx0 + LW / Z.k && bb[3] > vy0 && bb[1] < vy0 + LH / Z.k; };
    // the land in the tiles: water, then forest (Polissya)
    for (const [, t] of tiles) { if (!t) continue; for (const w of t.wa) { if (!vis(w.bb)) continue; path(w.p, true); g.fillStyle = '#9cc3dc'; g.fill(); g.strokeStyle = '#7fa8c4'; g.lineWidth = .5; g.stroke(); } }
    for (const [, t] of tiles) { if (!t) continue; for (const f of t.fo) { if (!vis(f.bb)) continue; path(f.p, true); g.fillStyle = '#a8c48f'; g.fill(); } }
    // rivers: the base rivers always, the streams from their tiles
    for (const [name, q] of CACHED.rivers) { path(q); g.strokeStyle = '#7fb0d0'; g.lineWidth = Math.max(1, 2.2 * Math.sqrt(k)); g.stroke(); }
    for (const [, t] of tiles) { if (!t) continue; for (const w of t.rv) { if (w.k === 2 && k < 3) continue; if (!vis(w.bb)) continue; path(w.p); g.strokeStyle = '#7fb0d0'; g.lineWidth = w.k === 0 ? Math.max(1, 2.2 * Math.sqrt(k)) : 1; g.stroke(); } }
    // rail: dashed dark
    g.setLineDash([4, 3]);
    for (const q of CACHED.rail) { path(q); g.strokeStyle = '#8a7f78'; g.lineWidth = Math.max(1, .9 * Math.sqrt(k)); g.stroke(); }
    for (const [, t] of tiles) if (t) for (const r of t.ra) { if (k < 2 || !vis(r.bb)) continue; path(r.p); g.strokeStyle = '#8a7f78'; g.lineWidth = Math.max(1, .9 * Math.sqrt(k)); g.stroke(); }
    g.setLineDash([]);
    // roads: the base (trunk, primary, secondary) always; tertiary and streets from the tiles as you zoom in
    const RCOL = ['#d9a050', '#f4f0e6', '#f4f0e6', '#f4f0e6'], RW = [2.6, 2.2, 1.8, 1.4];
    for (const [cls, ref, q] of CACHED.roads) { path(q); g.strokeStyle = '#c8a25a'; g.lineWidth = Math.max(2, (RW[cls] || 1.8) * Math.sqrt(k)); g.stroke(); path(q); g.strokeStyle = RCOL[cls] || '#f4f0e6'; g.lineWidth = Math.max(1.1, (RW[cls] || 1.8) * Math.sqrt(k) * .55); g.stroke(); }
    for (const [, t] of tiles) { if (!t) continue; for (const rd of t.ro) { const cls = rd.cls, br = rd.br; if (cls >= 3 && k < 8) continue; if (cls >= 2 && k < 2.5) continue; if (!vis(rd.bb)) continue;
      path(rd.p); g.strokeStyle = br ? '#8a7f78' : '#c8b58f'; g.lineWidth = Math.max(1, (RW[cls] ?? 1.1) * Math.sqrt(k) * 1.1); g.stroke();
      path(rd.p); g.strokeStyle = RCOL[cls] ?? '#f4f0e6'; g.lineWidth = Math.max(.6, (RW[cls] ?? 1.1) * Math.sqrt(k) * .6); g.stroke(); } }
    // the district boundary, on top of the land
    if (CACHED.bnd.length) { rings(CACHED.bnd); g.strokeStyle = '#4e4334'; g.lineWidth = 1.5; g.stroke(); }
    // buildings, from their own tiles (b-files), when a house is a few pixels (x32: about 15 m to the pixel)
    if (k >= 32) for (const [, t] of btiles) { if (!t) continue; for (const b of t.bd) { if (!vis(b.bb)) continue; path(b.p, true); g.fillStyle = '#c9c4bc'; g.fill(); g.strokeStyle = '#8a7f78'; g.lineWidth = .4; g.stroke(); } }
    x.imageSmoothingEnabled = false; x.clearRect(0, 0, c.width, c.height); x.drawImage(lo, 0, 0, c.width, c.height);
    labels(x); scalebar(x);
  }

  // the labels and markers (on the visible canvas, at full resolution): settlements, stations, landmarks
  function labels(x) {
    const u = R.c.width / LW || 2, k = Z.k;   // u: device pixels per map pixel (the low-res canvas is blown up to the visible one)
    R.marks.length = 0;
    const TAKEN = [], hit = (a, b) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];
    x.textBaseline = 'middle'; x.textAlign = 'left';
    const at = ll => { const [px, py] = T(B(ll)), X = Math.round(px * u), Y = Math.round(py * u); return (X < -60 * u || Y < -20 * u || X > R.c.width + 60 * u || Y > R.c.height + 20 * u) ? null : [X, Y]; };
    const say = (t, tx, ty, col) => { x.font = `700 ${Math.round(13 * u)}px 'Roboto Condensed', sans-serif`; x.lineWidth = 3 * u; x.strokeStyle = 'rgba(236,227,201,.95)'; x.strokeText(t, tx, ty); x.fillStyle = col; x.fillText(t, tx, ty); };
    const put = (p, t, col, sz) => { const s = (sz + 2) * u; TAKEN.push([p[0] - s / 2, p[1] - s / 2, s, s]); x.font = `700 ${Math.round(13 * u)}px 'Roboto Condensed', sans-serif`; const w = x.measureText(t).width, h = 13 * u, big = sz > 3;
      const opts = [[p[0] + s / 2, p[1] - h / 2], [p[0] - s / 2 - w, p[1] - h / 2], [p[0] - w / 2, p[1] - s / 2 - h], [p[0] - w / 2, p[1] + s / 2]];
      for (const [rx, ry] of opts) { const rc = [rx - 2, ry - 2, w + 4, h + 4]; if (rx < 2 || ry < 2 || rx + w > R.c.width - 2 || ry + h > R.c.height - 2) continue; if (TAKEN.some(o => hit(rc, o))) continue; TAKEN.push(rc); say(t, rx, ry + h / 2, col); return true; }
      return false; };
    const dot = (p, col, sz, ring) => { const s = sz * u; if (ring) { x.fillStyle = '#1b1611'; x.fillRect(p[0] - s / 2 - u, p[1] - s / 2 - u, s + 2 * u, s + 2 * u); } x.fillStyle = col; x.fillRect(p[0] - s / 2, p[1] - s / 2, s, s); };
    // settlements: the city and the towns at any zoom, villages from x3, hamlets from x6, suburbs from x16
    const KIND = { 3: 'місто', 2: 'смт', 1: 'село', .5: 'хутір' };
    for (const pl of (IDX.places || [])) { const [name, rank, ll, pop, osm] = pl; if (rank < .5 && k < 16) continue; if (rank < 1 && k < 6) continue; if (rank < 2 && k < 3) continue;
      const p = at(ll); if (!p) continue; R.marks.push({ t: name, kind: KIND[rank] || 'місцевість', p, ll, what: 'place', pop, osm }); dot(p, rank >= 2 ? '#1b1611' : '#4d4030', rank >= 3 ? 5 : rank >= 2 ? 4 : rank >= 1 ? 3 : 2, rank >= 2);
      if (rank >= 2 || k >= 3) put(p, name, rank >= 2 ? '#1b1611' : '#4d4030', rank >= 3 ? 5 : rank >= 2 ? 4 : 3); }
    // railway stations from x8
    if (k >= 8) for (const [name, ll] of (IDX.stations || [])) { const p = at(ll); if (!p) continue; R.marks.push({ t: name, kind: 'станція', p, ll, what: 'station' }); dot(p, '#1d5fa8', 2, false); if (k >= 24) put(p, name, '#1d5fa8', 2); }
    // landmarks: a gold dot like the minimap's, its name from x4
    for (const l of LMS || []) { const p = at(l.ll); if (!p) continue; R.marks.push({ t: l.name, kind: l.kind, p, ll: l.ll, what: 'lm', l }); dot(p, '#e0b84a', 4, true); if (k >= 4 && l.score >= 3) put(p, l.name, '#7a5c14', 4); }
    // the river names, along nothing simpler than the first stretch, from x3: the Уж, the Неруч...
    if (k >= 3) for (const [name, q] of CACHED.rivers) { if (!name) continue; const i = Math.floor((q.length - 1) * .5), [ax, ay] = T(q[i]), [bx, by] = T(q[Math.min(q.length - 1, i + 1)]); const p = [Math.round(ax * u), Math.round(ay * u)]; if (p[0] < 0 || p[1] < 0 || p[0] > R.c.width || p[1] > R.c.height) continue;
      x.save(); x.translate(p[0], p[1]); x.rotate(Math.atan2(by - ay, bx - ax)); x.font = `italic 500 ${Math.round(11 * u)}px 'Roboto Condensed', sans-serif`; x.lineWidth = 3 * u; x.strokeStyle = 'rgba(236,227,201,.9)'; x.strokeText(name, 0, 0); x.fillStyle = '#3f7ca6'; x.fillText(name, 0, 0); x.restore(); }
  }
  function scalebar(x) {   // a honest scale: the projection is local, so a metre is a metre everywhere on the screen
    const u = R.c.width / LW || 2;   // device pixels per map pixel
    const pxPerLon = B([IDX.box[2], 0])[0] - B([IDX.box[0], 0])[0], mAcross = (IDX.box[2] - IDX.box[0]) * 111320 * Math.cos((IDX.box[1] + IDX.box[3]) / 2 * Math.PI / 180);
    const mpp = mAcross / pxPerLon / Z.k / u;   // metres per screen pixel
    for (const m of [100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000]) if (m / mpp > 60) { const el = $('regscale'); el.querySelector('span').textContent = m >= 1000 ? `${m / 1000} км` : `${m} м`; el.querySelector('i').style.width = `${Math.round(m / mpp)}px`; return; }
  }

  // ------------------------------------------------------------ the tap: the nearest marker's card
  function card(m) { const C = $('regcard'), h = C.querySelector('h3'), p = C.querySelector('p'), s = C.querySelector('small');
    h.textContent = m.t;
    const links = [];
    if (m.what === 'lm' && m.l) { p.textContent = [m.l.desc || KINDTXT[m.l.kind] || m.l.kind, m.l.tags && m.l.tags.tourism === 'museum' ? 'музей' : null].filter(Boolean).join(' · ') || KINDTXT[m.l.kind] || m.l.kind;
      if (m.l.qid) links.push(`<a href="https://www.wikidata.org/wiki/${m.l.qid}" target="_blank" rel="noopener">Wikidata</a>`); }
    else p.textContent = m.kind || '';
    const osm = m.what === 'lm' ? (m.l && m.l.osm) : m.osm;
    if (osm) links.push(`<a href="https://www.openstreetmap.org/${osm}" target="_blank" rel="noopener">OpenStreetMap</a>`);
    if (m.pop) p.textContent += ` · ${m.pop.toLocaleString('uk-UA')} мешканців`;
    p.textContent = p.textContent.replace(/^ · /, '');
    s.innerHTML = links.length ? links.join(' · ') : 'OpenStreetMap';
    C.classList.add('on');
  }
  const KINDTXT = { park: 'парк', museum: 'музей', viewpoint: 'оглядовий майданчик', attraction: 'пам\'ятка', monument: 'пам\'ятник', castle: 'замок', rock: 'скеля', beach: 'пляж', mill: 'млин', tower: 'вежа', dam: 'гребля', sight: 'пам\'ятка' };
  function near(x, y) { let best = 1e9, m = null; for (const q of R.marks) { const d = Math.hypot(q.p[0] - x, q.p[1] - y); if (d < best) { best = d; m = q; } } const u = R.c.width / LW || 2; return best < 18 * u ? m : null; }

  // ------------------------------------------------------------ the pointer: drag pans, a still tap selects, two fingers pinch, the wheel zooms
  function wires() {
    const W = $('regwrap'), ptr = new Map(); let moved = false, pinch0 = 0;
    const loXY = e => { const r = R.c.getBoundingClientRect(); return [((e.clientX - r.left) / r.width) * LW, ((e.clientY - r.top) / r.height) * LH]; };
    W.addEventListener('pointerdown', e => { if (e.target.closest('button, #regcard, #regpick')) return; W.setPointerCapture(e.pointerId); ptr.set(e.pointerId, loXY(e)); moved = false; if (ptr.size === 2) { const [a, b] = [...ptr.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); } });
    W.addEventListener('pointermove', e => { if (!ptr.has(e.pointerId)) return; const q = loXY(e), p0 = ptr.get(e.pointerId); ptr.set(e.pointerId, q);
      if (ptr.size === 2) { const [a, b] = [...ptr.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); if (pinch0 > 0) zoom(d / pinch0, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2); pinch0 = d; moved = true; return; }
      const dx = q[0] - p0[0], dy = q[1] - p0[1]; if (Math.abs(dx) + Math.abs(dy) > 1.5) moved = true; if (moved) { Z.tx += dx; Z.ty += dy; clamp(); loadTiles(); draw(); } });
    const up = e => { if (!ptr.has(e.pointerId)) return; const q = ptr.get(e.pointerId); ptr.delete(e.pointerId); pinch0 = 0; if (moved || e.type !== 'pointerup') return;
      // q is already in zoomed low-res display space (loXY maps to the drawn canvas, which includes Z), so scale it straight to
      // device pixels — the marks are stored the same way. Re-applying Z.k/Z.tx here double-counted zoom and broke taps at k>1.
      const x = q[0] / LW * R.c.width, y = q[1] / LH * R.c.height;
      const m = near(x, y); if (m) card(m); else $('regcard').classList.remove('on'); };
    W.addEventListener('pointerup', up); W.addEventListener('pointercancel', e => ptr.delete(e.pointerId));
    W.addEventListener('wheel', e => { e.preventDefault(); e.stopPropagation(); const r = R.c.getBoundingClientRect(), q = loXY(e); zoom(e.deltaY < 0 ? 1.22 : 1 / 1.22, q[0], q[1]); }, { passive: false });
    $('regclose').addEventListener('click', () => close());
    $('regplus').addEventListener('click', () => zoom(1.5, LW / 2, LH / 2));
    $('regminus').addEventListener('click', () => zoom(1 / 1.5, LW / 2, LH / 2));
    $('regcard').querySelector('x').addEventListener('click', () => $('regcard').classList.remove('on'));
    $('regpickb').addEventListener('click', () => { pickOpen = !pickOpen; $('regpick').classList.toggle('on', pickOpen); });
    $('regpick').addEventListener('click', e => { if (e.target.id === 'regpick') { pickOpen = false; $('regpick').classList.remove('on'); } });
    addEventListener('resize', () => { if (R && R.open) { fit(); draw(); } });
    addEventListener('keydown', e => { if (!R || !R.open) return; if (e.key === 'Escape') { e.stopPropagation(); close(); } if (e.key === '+' || e.key === '=') zoom(1.4, LW / 2, LH / 2); if (e.key === '-') zoom(1 / 1.4, LW / 2, LH / 2); });
  }

  // ------------------------------------------------------------ open / close
  async function open(id) {
    const bt = await boot(); if (!bt) return false;
    if (!R) { const dom = bt.dom; R = { dom, open: false, c: $('regc'), lo: document.createElement('canvas'), list: bt.list, marks: [], path: '' }; wires(); }
    const reg = id ? bt.list.find(r => r.id === id) : bt.list[0];
    if (!reg) return false;
    const idx = await fetch(`${reg.path}/data/index.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!idx) { console.warn('region map: no data/index.json in', reg.path); return false; }
    IDX = idx; R.path = reg.path; R.marks = []; tiles = new Map(); btiles = new Map();
    project(idx);
    R.lo.width = LW; R.lo.height = LH;
    $('regname').textContent = reg.name;
    LMS = await fetch(`${reg.path}/data/landmarks.json`).then(r => r.ok ? r.json() : []).catch(() => []);
    NBR = await fetch(`${reg.path}/data/neighbours.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    NBR = NBR && NBR.rings ? NBR.rings : [];
    CACHED = {   // every base layer through the projection once: draw() only applies zoom and pan
      bnd: (IDX.bnd || []).map(r => r.map(B)),
      nbr: NBR.map(r => r.map(B)),
      rivers: ((IDX.base || {}).rivers || []).map(([n, pts]) => [n, pts.map(B)]),
      rail: ((IDX.base || {}).rail || []).map(pts => pts.map(B)),
      roads: ((IDX.base || {}).roads || []).map(([c2, ref, pts]) => [c2, ref, pts.map(B)]),
    };
    $('regpickb').hidden = bt.list.length < 2;
    const L = $('regpickl'); L.replaceChildren();
    for (const r of bt.list) { const b = document.createElement('button'); b.type = 'button'; b.innerHTML = `${r.name}<small>${r.oblast || ''}</small>`; b.addEventListener('click', () => { pickOpen = false; $('regpick').classList.remove('on'); open(r.id); }); L.appendChild(b); }
    $('regcard').classList.remove('on');
    const RB = $('regride'); RB.hidden = true; RB.onclick = null;
    await trips();
    const ride = rideLink(reg.trip);   // a region entry may name the trip that rides it (registry data); the link works from any trip's page
    if (ride) { RB.hidden = false; RB.onclick = () => { location.href = ride; }; }
    R.open = true; R.dom.classList.add('open'); document.body.classList.add('reg');
    if (hooks.onOpen) try { hooks.onOpen(); } catch {}
    fit(); loadTiles(); draw();
    return true;
  }
  function close() { if (!R || !R.open) return; R.open = false; R.dom.classList.remove('open'); document.body.classList.remove('reg'); if (hooks.onClose) try { hooks.onClose(); } catch {} }
  const isOpen = () => !!(R && R.open);

  // ?region=<id> opens the map straight away, over the start screen if it is still up
  const want = params.get('region');
  if (want) boot().then(() => want && open(want));
  return { open, close, toggle: () => isOpen() ? close() : open(), isOpen, boot, _d: () => ({ LW, LH, Z: { ...Z }, nbr: NBR ? NBR.length : -1, bnd: IDX && IDX.bnd ? IDX.bnd.length : -1, roads: CACHED ? CACHED.roads.length : -1, rivers: CACHED ? CACHED.rivers.length : -1, tiles: [...tiles.keys()], btiles: [...btiles.keys()], lo: R ? [R.lo.width, R.lo.height] : null, marks: R ? R.marks.length : -1 }) };   // _d: for the tests, like OV.world
}
