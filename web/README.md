# BikeRouteNicePDX — Web Frontend

React 18 + Vite + MapLibre GL PWA.

## Dev setup

```bash
# From repo root (npm workspaces)
npm install

# Copy env template
cp web/.env.example web/.env.local

# Start dev server (proxies /api → localhost:3000)
npm run dev:web
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `/api` | Backend base URL. In dev, Vite proxies `/api` to `http://localhost:3000`. In production, set to the deployed server URL. |
| `VITE_BASEMAP_URL` | `/portland.pmtiles` | PMTiles basemap path or URL. |

### Basemap fallback

`/portland.pmtiles` is gitignored (large binary, built by `scripts/build-tiles.ts`).
Without it the map has a blank basemap in dev. Two options:

1. Run `npm run build:tiles` to generate the PMTiles file and put it in `web/public/`.
2. Leave `VITE_BASEMAP_URL` empty (`VITE_BASEMAP_URL=`) to fall back to the free
   MapLibre demotiles OSM raster style (`https://demotiles.maplibre.org/style.json`).
   This style doesn't need any file — it fetches tiles from the internet.

## Greenways overlay

`web/public/greenways.geojson` is a placeholder (empty FeatureCollection).
Populate it by running the data pipeline from the repo root:

```bash
npm run fetch:pbot    # downloads PBOT GIS data
npm run build:graph   # spatial join → annotated graph
# The pipeline writes web/public/greenways.geojson as a side effect
```

## Icons

Icons were generated from `web/icon.svg` using `npx sharp-cli`:

```bash
npx sharp-cli -i icon.svg -o public/icon-192.png resize 192 192
npx sharp-cli -i icon.svg -o public/icon-512.png resize 512 512
```

Re-run those commands if you update the SVG.

## PWA / Service Worker

vite-plugin-pwa handles SW registration (autoUpdate mode). In v0.1 the SW only
caches the app shell (JS/CSS/HTML). Tile + map offline caching is a v1.0 task —
see `src/service-worker.ts` for the TODO notes.

## File overview

```
src/
  types.ts            Shared TS types matching server API contract
  api.ts              Typed fetch client (/route, /search, /health)
  App.tsx             Root layout + state (from/to, route, flyTo)
  styles.css          Plain CSS — no Tailwind; CSS Grid + custom properties
  vite-env.d.ts       Vite + vite-plugin-pwa ambient type refs
  main.tsx            React root + SW registration
  service-worker.ts   v0.1 stub (Workbox fills in from vite.config.ts)
  components/
    Map.tsx             MapLibre map, greenway overlay, route line, markers
    SearchBar.tsx       Typeahead address input
    EndpointInputs.tsx  Stacked start/end inputs + locate + swap
    RouteSummary.tsx    Distance / duration / greenway coverage pills
    DirectionsPanel.tsx Turn-by-turn steps with network class pills
  hooks/
    useRoute.ts           Fetches route when from+to are set (debounced 400ms)
    useGeolocation.ts     Browser geolocation on demand
    useDebouncedSearch.ts Debounced /search calls (300ms)
```

## Build

```bash
npm run build        # tsc + vite build → dist/
npm run preview      # serve dist/ locally
npm run typecheck    # type-only check, no emit
```
