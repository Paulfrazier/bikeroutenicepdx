# BikeRouteNicePDX — Routing Layer

Valhalla bicycle router configured for Portland greenway preference.

## Files

```
routing/
├── docker-compose.yml   — single-service Valhalla stack
├── valhalla.json        — engine config (mjolnir, costing_options, service_limits)
├── costing-overrides.json — cost factor table (source of truth for tuning)
├── conf/
│   └── graph.lua        — Lua tagging callback (runs at tile-build time)
└── README.md            — this file
```

## First-time tile build

```bash
cd routing
docker compose up --build
```

The `gisops/valhalla` image's entrypoint checks whether tiles already exist in
the `valhalla_tiles` volume. If not, it runs `valhalla_build_tiles` against
`/data/portland-tagged.osm.pbf` before starting the tile server. First build
takes 3–10 minutes depending on hardware.

Watch progress:

```bash
docker compose logs -f valhalla
```

The service is ready when you see `Tile server started` and the healthcheck
passes (`docker compose ps` shows `healthy`).

## Rebuild after PBF changes

After running `npm run build:graph` from the repo root (which regenerates the
tagged PBF and the way-tags.json sidecar):

```bash
docker compose down -v && docker compose up --build
```

The `-v` flag destroys the `valhalla_tiles` volume so tiles are rebuilt from
scratch. **Do not omit `-v`** — stale tiles from the previous build will
otherwise be served.

## Test routing with curl

```bash
curl -X POST http://localhost:8002/route \
  -H 'Content-Type: application/json' \
  -d '{
    "locations": [{"lat":45.5,"lon":-122.65},{"lat":45.55,"lon":-122.6}],
    "costing": "bicycle",
    "costing_options": {"bicycle": {"bicycle_type": "Hybrid", "use_roads": 0.1, "use_hills": 0.5}}
  }'
```

You can also hit the status endpoint:

```bash
curl http://localhost:8002/status
```

## Where the Lua callback lives

`conf/graph.lua` is mounted at `/conf/graph.lua` inside the container and
referenced by `valhalla.json → mjolnir.lua`. It runs **once per way** during
tile construction, not at request time.

The callback:
1. Reads our custom `bicycle_network_class` OSM tag (injected by
   `scripts/build-graph.ts`) and translates it into Valhalla-native tags
   (`cycleway=*`, `bicycle=designated`, `bicycle_safety=<float>`).
2. Loads `/data/way-tags.json` at startup to pick up per-way difficult-crossing
   counts from the PBOT point layer; these nudge the `bicycle_safety` score
   upward (worse) proportionally.

## Known limitation: Valhalla cannot natively consume `bicycle_network_class`

Valhalla's bicycle costing reads OSM tags it knows about (`cycleway`, `bicycle`,
`highway`, `surface`, etc.) but has no hook for arbitrary custom tags. There is
no `costing_options` field that maps a custom tag to a cost multiplier.

Our workaround is the Lua callback chain:

```
bicycle_network_class (custom OSM tag, from build-graph.ts)
    ↓  graph.lua translates at tile-build time
cycleway=* / bicycle=* / bicycle_safety=<float>  (Valhalla-native)
    ↓  Valhalla bicycle costing reads
edge cost multiplier applied during A* routing
```

The `bicycle_safety` float (0.0 → 1.0, lower = safer) is the primary lever.
Valhalla uses it as a comfort weight: edges with lower bicycle_safety are
preferred all else being equal, which is exactly the behavior we want.

The mapping from class to safety float is documented in
`costing-overrides.json → _notes.bicycle_safety_mapping`. If you change factors,
update **both** that file and the `SAFETY_MAP` table in `conf/graph.lua`.

## Tuning

Cost factors live in `costing-overrides.json`. After changing them:

1. Update `SAFETY_MAP` in `conf/graph.lua` to match.
2. Rebuild tiles: `docker compose down -v && docker compose up --build`
3. Run the canonical route test suite: `cd .. && npm run test:routes`
4. Both gates must pass:
   - Average greenway/path/protected coverage > 70%
   - No route puts > 200m on known-bad streets (see `costing-overrides.json → thresholds.forbidden_streets`)
