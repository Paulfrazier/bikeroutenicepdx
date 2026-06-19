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

## Conflict resolution

When PBOT and OSM disagree, **PBOT wins**. `scripts/build-graph.ts` writes a modified PBF where edges intersecting PBOT greenway geometry get tagged with our internal `bicycle_network_class` key. `scripts/reconcile.ts` emits a divergence CSV — log only for v0.1, candidates for upstream OSM edits in v1.0.
