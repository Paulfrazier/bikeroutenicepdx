# BikeRouteNicePDX — Server

Node + Hono API server. Wraps a local Valhalla instance (bicycle routing) and the public Nominatim geocoder (search), biased to the Portland metro area.

## Install

```bash
cd server
npm install
```

## Dev

```bash
npm run dev        # tsx --watch, auto-restarts on save
```

## Build + start (production)

```bash
npm run build      # tsc → dist/
npm run start      # node dist/index.js
```

## Type check

```bash
npm run typecheck
```

## Environment variables

Copy `.env.example` to `.env` and fill in:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `VALHALLA_URL` | `http://localhost:8002` | Local Valhalla instance (see `routing/`) |
| `NOMINATIM_URL` | `https://nominatim.openstreetmap.org` | Override with self-hosted instance for production |
| `WEB_ORIGIN` | `http://localhost:5173` | Allowed CORS origin for the frontend |

## API contract

See the parent project spec. Summary:

- `POST /route` — `{ from: [lng,lat], to: [lng,lat] }` → GeoJSON route + steps
- `GET /search?q=&limit=` — geocoding, bounded to Portland bbox
- `GET /health` — liveness + Valhalla reachability

Error shape: `{ error: string, code: string }` with appropriate HTTP status.
