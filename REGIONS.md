# REGIONS.md — the region (district) map system

A **region** is a zoomable pixel overview map of one district (raion), baked from OpenStreetMap and shown
as a screen inside the game. Phase 1 was the map; Phase 2 added the ride through the region: a region
may name the trip that rides it, and the region folder's data keeps the same shape as a trip's.

Korosten Raion (`korosten`) is region #1. **Adding another district is a data task, not a code task**: no
region-specific logic exists in the viewer — everything the map draws comes from the registry and the
region's data files.

## How it works

```
regions/
  registry.json          one line per region: the index the viewer reads
  korosten/
    region.json          the source config for scripts/region.mjs (which OSM relation, grid step)
    .cache/              Overpass/Wikidata cache (gitignored; reruns cost the services nothing)
    data/
      index.json         the base layer, always loaded first (see below)
      c0000..c0017.json  the grid tiles, lazy-loaded by viewport
      b0003.json …       the building footprints, one file per tile that has them (deep-zoom data)
      land.json          {box, rings} — the district boundary, as the land polygons (same shape as a trip's)
      borders.json       {lines}      — the same boundary as strokeable lines (same shape as a trip's)
      neighbours.json    {rings, names} — the surrounding districts' boundaries, simplified
      landmarks.json     [{name, kind, qid, ll, osm, tags, score, desc}] — sights, ranked by fame
      LICENSE            ODbL (the data is a derived database of OpenStreetMap)
```

`templates/regionmap.js` (copied into a trip by `scripts/viewer.mjs`) reads `regions/registry.json` and
draws whatever regions it finds. No registry (or no `regions/` folder installed) — the entry points stay
hidden and nothing else changes.

## Baking a region

```sh
node scripts/region.mjs --id korosten                 # reads regions/korosten/region.json
#   --overpass http://127.0.0.1:12345/api/interpreter  your own server, if the public ones are slow
#   --tile 0.4                                          the grid step in degrees (default from region.json)
```

1. Create `regions/<id>/region.json`:

```json
{
  "id": "malyn",
  "name": "Малинський район",
  "name_en": "Malyn Raion",
  "oblast": "Житомирська область",
  "country": "Україна",
  "osm": { "relation": 12345678, "admin_level": 6, "name:uk": "Малинський район" },
  "tile": 0.4
}
```

   Find the relation id in OSM (search the district, note the relation number) or with an Overpass query:
   `relation["boundary"="administrative"]["admin_level"="6"]["name:uk"="<район>"];`. Post-2020 raions are
   `admin_level=6`; an oblast is `admin_level=4` and would work the same, just with a bigger grid.

2. Run the bake. It fetches (through the polite, disk-cached `lib.mjs` helpers):
   - the district boundary from the OSM relation;
   - one Overpass query per grid tile: roads (with bridge flags), railways, rivers/streams/canals,
     lakes, forest polygons, building footprints, railway stations, place nodes;
   - the surrounding districts' boundaries (the neighbours);
   - named sights (tourism/historic/parks/rocks/mills/dams with a Wikidata id where present), then
     Wikidata sitelink counts to rank them.

   Everything is filtered to the district polygon (a feature whose centre is outside the boundary is
   dropped), lines are simplified (~12 m), forests ~20 m, the boundary ~120 m, neighbours ~400 m.
   Rerunning skips nothing here but every download is cached, so it is cheap.

3. The script writes the data files listed above and adds/updates the entry in `regions/registry.json`.

4. Rebuild the viewer so the trip folder carries the regions:
   `node scripts/viewer.mjs --trip trips/ukraine-loop` (see README).

## The data formats

Same conventions as `trips/ukraine-loop/` so a region and a trip share the shape; positions are
`[lon, lat]` at 1e-6, tile coordinates are integer metres from the tile origin (the equirectangular
`KX = cos(lat) * 111320, KY = 110540` local metres the whole engine uses).

- `registry.json` — `{"regions":[{id, name, name_en, oblast, path, box, generated, source}]}`. The viewer
  trusts nothing but this file to decide what exists.
- `index.json` — the always-loaded base: `box`, `grid {nx, ny, tile}`, `bnd` (boundary rings, simplified),
  `base {roads: [[class, ref, line]], rivers: [[name, line]], rail: [line]}`, `places:
  [[name, rank, ll, population, osm]]`, `stations: [[name, ll]]`, `source`, `credits`.
  Road class: 0 motorway/trunk, 1 primary/secondary, 2 tertiary, 3 unclassified/residential.
  Place rank: 3 city, 2 town, 1 village, 0.5 hamlet, 0.2 suburb (drawn only deep into the zoom).
- `cNNNN.json` — tile `c = j * nx + i` of the grid over `box`, `origin` = the tile's SW corner,
  `box` = `[lon0, lat0, lon1, lat1]`:
  `ro` roads `[[class, bridge?, [x, y]…]]`, `rv` waterways `[[class, name?, line]]` (0 river, 1 canal,
  2 stream), `ra` railways, `wa` water-area rings, `fo` forest rings, `st` stations.
  A line is clipped to the tile it is stored in (it appears in every tile it crosses); a polygon is stored
  once, in the tile of its centroid.
- `bNNNN.json` — the building footprints of the same tile (`{c, origin, bd: [ring…]}`), a file of their
  own because they are deep-zoom data: the viewer loads c-files from the first pinch (~×2) and b-files
  only from ~×16, when a house is a few pixels. A tile with no buildings gets no b-file.
- `land.json`, `borders.json`, `neighbours.json`, `landmarks.json` — the same shapes as the trip files of
  those names (`land.json` = outline, `borders.json` = `{lines}`, `neighbours.json` = `{rings}` plus
  `names`, `landmarks.json` = the array the trip's landmark list uses, with `ll` in place of `s/side`
  because a region has no road yet).

When Phase 2 adds the ride, the region folder gains `route.json`, `site.json` and baked chunk data in the
trip's own format, and the viewer already treats the two the same way.

## The ride through a district (Phase 2)

`trips/korosten` is the Korosten Raion trip: a 360 km loop (Korosten → Malyn → Narodychi → Ovruch → Olevsk →
Korosten), baked with the same pipeline as the loop (`route.mjs` then `bake.mjs`), riding on the Polissya art kit.
The wiring between the two systems is data, not code:

- a region's `region.json` (and so its registry entry) may carry `"trip": "<id>"` — the id of the trip that rides
  the district. The region screen then shows a «Поїхати» button that opens that trip's page.
- `scripts/viewer.mjs` writes a `trips.json` into every built trip: the site's other trips, with a path relative
  to that build. The start screen's «Маршрут» row and the region screen's «Поїхати» both read it; a build with no
  other trips shows neither. The loop is the site's front page, every other trip is a folder of its own
  (`/korosten/`), and a trip's `site.json` (`"id"`, `"title"`) says which one that build is.
- a trip's `route.json` may carry `"world": "<id>"` (bake.mjs copies it into `data/index.json`): the open world's
  room names, so riders of two different trips never land in one room.

So the Korosten trip starts in Korosten (its start screen's «Старт» lists every place along the route — Korosten,
Malyn, Narodychi, Ovruch, Olevsk and the villages between), is reachable from the region map's «Поїхати», and
links back to the loop from its own start screen.

## Neighbours and the future oblast view

Every region carries `neighbours.json`: the boundary rings of the districts around it, simplified. Two
adjacent districts baked from OSM agree on their shared border because it is the same OSM ways. That is
the seam data for stitching districts into an oblast view — deliberately **not built yet**, and nothing in
the current format blocks it: the projection is per-region equirectangular (a metre is a metre), the
registry carries each region's `box`, and the neighbours' rings are already drawn muted around the
district, which is the visual half of a stitch. An oblast view would merge the boxes, load the tiles of
whichever districts are in view, and draw the shared borders once.

## The screen

Opened with **K**, the dock's **◱** (touch), or **«Райони»** on the big country map (O). `?region=korosten`
opens it directly. Pinch zooms (1×–64×), drag pans, a tap on a settlement, station or landmark opens a
card (name, kind, population, links to OSM and Wikidata). The base layer paints the whole district at
once (~90 KB gzipped); the c-tiles stream in from the first pinch and add forests, streams and streets,
the b-tiles (buildings) only at deep zoom. The layout fits portrait and landscape (the buttons move above
the map on an upright phone), and the mouse, wheel and keyboard keep working.

Attribution is required wherever the map is shown: OpenStreetMap (ODbL) — the credits line is on the map
itself, and `data/LICENSE` travels with the data.
