# BikeRouteNicePDX

Portland Greenway Router — a PWA that routes bikes against PBOT's authoritative neighborhood greenway GIS data with a custom cost profile that strongly prefers greenways over arterials.

## Why

Portland has 100+ miles of designated neighborhood greenways: low-traffic, low-speed residential streets engineered with diverters, speed bumps, and protected crossings. PBOT publishes the network as authoritative GIS data, but no routing app uses it directly:

- **Google/Apple Maps** — generic bike routing, sometimes routes onto arterials
- **Ride With GPS** — routing engine isn't greenway-aware; users draw routes manually
- **cycle.travel / Pointz / OsmAnd+BRouter** — pull greenway data from inconsistent OSM tags
- **PBOT Interactive Bike Map** — authoritative data but no routing

This app uses PBOT GIS as the preference layer, OSM as the routing graph, and Valhalla as the engine.

## Architecture

| Layer | Tech |
|---|---|
| Frontend | React + Vite + MapLibre GL JS |
| Basemap | Self-hosted PMTiles |
| Routing | Valhalla (Docker) with custom bicycle costing |
| Server | Node + Hono |
| Data | PBOT ArcGIS REST + Portland OSM PBF (Geofabrik) |

## Repo layout

```
BikeRouteNicePDX/
├── docs/        cost model, data sources, reconciliation notes
├── data/        gitignored, fetched by scripts
├── scripts/     fetch + build pipeline (PBOT, OSM, graph, tiles)
├── routing/     Valhalla config + docker-compose
├── server/      Hono app: /route, /search
├── web/         React PWA
└── tests/       canonical test routes + harness
```

## Quickstart

```bash
# 1. Install workspace deps
npm install

# 2. Fetch data
npm run fetch:pbot
npm run fetch:osm
npm run build:graph

# 3. Build Valhalla tiles + start router
cd routing && docker compose up --build

# 4. Run server
cd ../server && npm run dev

# 5. Run web app
cd ../web && npm run dev

# 6. Validate against canonical routes
cd .. && npm run test:routes
```

## License

Code: MIT. PBOT data: public domain. OSM data: ODbL — attribute appropriately.

## Status

MVP v0.1 in progress. See `/Users/pfrazier/.claude/plans/gonna-call-this-bikeroutenicepdx-stateless-hejlsberg.md` for full plan.
