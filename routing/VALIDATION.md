# Validating the greenway-tuned Valhalla (local, Docker)

> ## ⚠️ Validation result (2026-06-20): baked-tag approach does NOT work well
> A full local tile build + `npm run test:routes` (8 canonical routes) was run
> against stock Valhalla with the tagged PBF. Result: **1/8 pass**, coverage
> mostly 20–35% — often *worse* than the public Valhalla baseline (~38%).
> Diagnostics:
> - Tags land correctly: a greenway edge reports `cycle_lane=separated`,
>   `bike_network=true`. So Valhalla reads them.
> - But `use_roads=0` and `use_roads=1` produce **identical routes** — Valhalla
>   scores quiet residential ≈ greenway, so the preference barely moves routing.
> - The stronger lever `highway=cycleway` made coverage **worse** (route 1:
>   24% → 2%).
>
> **Conclusion:** strong greenway adherence is not achievable by injecting OSM
> tags into stock Valhalla. Real options: (a) a custom per-tag bike profile in
> **BRouter** (designed for exactly this), (b) a **route-snapping post-process**
> that pulls Valhalla's path onto the PBOT greenway network, or (c) genuine
> custom Valhalla costing (fork). **Do not host the baked-tag Valhalla** — it
> would regress routing vs the current public server.

---

Goal (original): confirm that routes prefer PBOT greenways **before** paying to
host a custom Valhalla. Greenway preference is baked into the OSM ways as standard tags
(`cycleway=track` / `bicycle=designated` / `lcn=yes`) by `scripts/build-graph.ts`,
so this runs **stock** `gisops/valhalla` — no custom Lua.

## Prerequisites
- Docker (Desktop / Colima / OrbStack)
- `osmium-tool`, Node 20+ (for the data pipeline)

## 1. Build the tile inputs (no Docker)
```bash
npm run fetch:osm            # Oregon extract → cropped Portland PBF (~200MB DL, one-time)
npm run export:bike-network  # live PBOT layer 75 → web/public/bike-network.geojson
npm run build:graph -- --force
```
`build:graph` spatial-joins PBOT classes onto OSM ways and writes
`data/reconciled/current/portland-tagged.osm.pbf` with the bike tags baked in
(plus `way-tags.json`). Expect a summary like `7478 ways tagged`
(greenway/protected/off_street/buffered/standard counts).

Spot-check the bake:
```bash
osmium tags-filter data/reconciled/current/portland-tagged.osm.pbf w/lcn=yes -f opl | grep -c '^w'
# Should be ~2400+ (vs ~26 in the untagged extract)
```

## 2. Build + serve tiles (Docker)
```bash
cd routing
docker compose down -v && docker compose up --build   # first run builds tiles (~minutes)
# wait for healthy:
curl -s localhost:8002/status
```

## 3. Run the route-quality harness
```bash
# in another shell, from repo root:
cd server && VALHALLA_URL=http://localhost:8002 npm run dev
# then, from repo root:
API_URL=http://localhost:3000 npm run test:routes
```
**Pass = mid-route greenway coverage climbs toward the ~0.70 targets in
`tests/routes/canonical.json`** (vs ~0.38 on the public Valhalla today), expected
greenway street-name hits, and no forbidden-arterial violations.

Compare a single route before/after:
```bash
curl -s -X POST localhost:3000/route -H 'Content-Type: application/json' \
  -d '{"from":[-122.6470,45.5495],"to":[-122.6560,45.5300],"preference":"comfort"}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=JSON.parse(s);console.log('coverage',(r.greenway_coverage*100).toFixed(0)+'%','dist',r.distance_m)})"
```

## 4. If greenways still aren't preferred enough
Tune in this order (rebuild tiles after each: `docker compose down -v && up --build`):
1. Confirm tags are present (step 1 spot-check).
2. Lower the default `use_roads` toward 0 in `server/src/services/valhalla.ts`
   (`USE_ROADS_BY_PREFERENCE.comfort`).
3. Strengthen `CLASS_TAGS` in `scripts/build-graph.ts` (e.g. add `segregated=yes`,
   or promote off_street to `highway=cycleway`).

## 5. Once validated → host on Railway
Add a second Railway service from a `routing/Dockerfile` (FROM `gisops/valhalla`,
COPY the tagged PBF + `valhalla.json`, build tiles at image-build time), then set
the server service's `VALHALLA_URL` to the new service's URL. (Deferred until
local validation passes.)
