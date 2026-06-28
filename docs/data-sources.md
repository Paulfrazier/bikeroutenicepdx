# Data Sources

## PBOT (City of Portland Bureau of Transportation)

Public domain per OSM Portland wiki confirmation from the City. Fetched quarterly via `scripts/fetch-pbot.ts` using ArcGIS REST APIs.

Portal: https://gis-pdx.opendata.arcgis.com/
Interactive viewer: https://www.portlandmaps.com/

### Required layers

| Purpose | Layer | Notes |
|---|---|---|
| Greenway lines | "Bicycle Network" — filter to neighborhood greenway class | Names like "Going", "Tillamook", "Klickitat" |
| Bike infra classes | "Bicycle Network" full layer | Greenway / protected / buffered / standard / shared roadway |
| Difficult crossings | PBOT difficult crossings point layer | Used for +60s penalty in costing |
| Wayfinding signs | PBOT bike wayfinding sign points | Destinations like "Sabin", "Downtown" — used for v1.0 turn cues |
| Off-street paths | Springwater, Marine Drive, Esplanade, Eastbank | Highest-priority routing class (0.15x cost) |

### Endpoint pattern

ArcGIS REST: append `/query?where=1=1&outFields=*&f=geojson` to the layer URL.

Concrete URLs go in `scripts/fetch-pbot.ts` and are versioned in code (not here) so the canonical source is the script.

### Refresh cadence

Quarterly. Re-run `npm run fetch:pbot` and tag the output folder `data/pbot/<YYYY-MM-DD>/`. The active build symlinks `data/pbot/current/`.

## OpenStreetMap

License: ODbL. Attribute as: "© OpenStreetMap contributors".

Source: Geofabrik daily extracts — https://download.geofabrik.de/north-america/us/oregon.html

We use the Oregon extract and crop to a Portland metro bbox (roughly: -123.0, 45.3, -122.3, 45.7) before feeding Valhalla.

OSM tags relevant to routing decisions:
- `lcn=yes` — local cycle network (most greenways have it but coverage is incomplete)
- `bicycle=designated` — designated bike infrastructure
- `cycleway=*` — on-street bike lane types
- `highway=cycleway` / `highway=path` — off-street paths
- `maxspeed=20 mph` — Portland greenway speed signs

## PBOT supplement — built-but-unpublished facilities

PBOT's published GIS (the `bike-network.geojson` the routing graph consumes) lags
reality by ~2 years. Facilities opened in 2024-2026 (sourced from PBOT news
releases / project pages) are absent from it, so they reach neither routing nor the
OSM backlog. `data/pbot-supplement/` closes that gap:

- `new-builds.manifest.json` — hand-curated, one row per corridor: `name`, PBOT
  `class`, authoritative `from`/`to` cross-streets + `source_url` + `completed`.
- `scripts/build-supplement.ts` (`npm run build:supplement`) resolves each row to
  geometry by clipping the named OSM street between the real OSM intersections of
  its `from`/`to` cross-streets, and writes `new-builds.geojson` — each LineString
  carrying `class`, `name`, a reader-facing `build_note`, `source_url`, `completed`.
- `scripts/export-bike-network.ts` **merges `new-builds.geojson` into
  `bike-network.geojson`** (with `rclass = class`, the facility code, and the
  `build_note`/`source_url`/`completed` passed through). Because `bike-network.geojson`
  is the single source consumed everywhere, the supplement then flows automatically to:
  - **the map** — web (`Map.tsx`) and iOS (`BikeNetworkLoader.swift`) draw it through
    the existing bike-network layer, styled identically to official lanes;
  - **routing** — `build-graph.ts` reads the same file, so supplement facilities go
    through the spatial join into `way-tags.json` → the **selfbuild** BRouter tiles
    and the OSM backlog. No separate in-graph merge.

  Build order matters: `build:supplement` → `export:bike-network` → `build:graph`.
  `build:supplement` reads `osm-ways.geojson` from a prior `build:graph` (street
  geometry is stable), so on a clean tree run `build:graph` once first to seed it.

**`build_note`** rides on each supplement feature for an app "learn more about
network" panel (provenance: which PBOT project, when opened, source link). Marked
`supplement: true` to distinguish curated additions from PBOT's published data.

**Scope of effect:** the map and the self-hosted `selfbuild` routing engine. The
default `prod` engine (stock brouter.de tiles) updates only when the edits land
upstream in OSM — see [OSM_EDITS.md](OSM_EDITS.md).

**Lifecycle:** lives outside `data/pbot/current/`, so quarterly `fetch:pbot` never
clobbers it. **Retire a row** once the facility appears in PBOT's GIS (or upstream
OSM) to avoid double-listing.

## Conflict resolution

When PBOT and OSM disagree, **PBOT wins**. `scripts/build-graph.ts` writes a modified PBF where edges intersecting PBOT greenway geometry get tagged with our internal `bicycle_network_class` key. `scripts/reconcile.ts` emits a divergence CSV — log only for v0.1, candidates for upstream OSM edits in v1.0.
