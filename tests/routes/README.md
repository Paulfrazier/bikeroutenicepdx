# Route Quality Test Harness

Validates that the BikeRouteNicePDX routing engine:
- Prefers PBOT-designated neighborhood greenways (target: ≥70% of each route on greenway/off-street/protected surfaces)
- Avoids known-bad arterials with no more than 200m of contiguous travel

## Running

Start the full stack first (two terminal windows):

```bash
# Terminal 1 — Valhalla
cd routing && docker compose up -d

# Terminal 2 — Hono server
cd server && npm run dev
```

Then from repo root:

```bash
npm run test:routes
```

`API_URL` defaults to `http://localhost:3000`. Override with:

```bash
API_URL=http://staging.example.com npm run test:routes
```

## What each test checks

Each route in `canonical.json` asserts three things:

| Check | Source | Pass condition |
|---|---|---|
| Greenway coverage | Computed from `step.bicycle_network_class` | ≥ per-route threshold (default 0.70) |
| Greenway hit | `step.street_name` substring match | At least one `expected_greenways` entry appears |
| Forbidden streets | `step.street_name` + contiguous distance accumulation | No forbidden street has >200m contiguous travel |

The coverage threshold for routes 2, 7, 8 is relaxed to 0.65 because those routes must use bridges or cross arterial networks where greenway surface is unavailable.

### Global forbidden streets (from `routing/costing-overrides.json`)

- Sandy Blvd
- SE Powell Blvd
- SE Cesar Chavez Blvd
- NE Martin Luther King Jr Blvd
- W Burnside St / E Burnside St
- 82nd Ave

Each test route also has route-specific forbidden streets (e.g. "NE Broadway" for the Sabin→Lloyd route).

### Coverage computation

`greenway_coverage` from the server may be 0 in v0.1 (not yet implemented server-side). The harness always recomputes coverage from `steps` using `bicycle_network_class ∈ {off_street, greenway, protected}`. The server value is logged as a cross-check when non-zero.

## Adding a new test route

1. Open `tests/routes/canonical.json` and append a new object following the schema:

```jsonc
{
  "id": "09-my-route",                   // kebab-case, numeric prefix for ordering
  "name": "Origin → Destination",
  "from": { "name": "...", "lng": -122.XXX, "lat": 45.XXX },
  "to":   { "name": "...", "lng": -122.XXX, "lat": 45.XXX },
  "expected_greenways": ["NE Foo St"],   // at least one must appear in route steps
  "forbidden_streets": ["SE Bar Ave"],   // route-specific extras beyond global list
  "expected_greenway_coverage": 0.70
}
```

2. Run `npm run test:routes` and check the output.
3. If the route fails due to a coverage or greenway miss, consider whether the issue is the test data (wrong coordinates, wrong expected greenway name) or a routing engine deficiency to fix.

## Interpreting tuning iterations

Results are saved to `tests/results/<ISO-timestamp>.json`. Compare runs before and after changing `routing/costing-overrides.json` or `routing/conf/graph.lua` to see whether a cost-factor adjustment improved or degraded routing quality.

Key fields in the JSON:
- `computed_coverage` — greenway fraction from steps (authoritative)
- `server_coverage` — value from server response (cross-check, may be 0)
- `forbidden_violations` — list of streets with their max contiguous distance
- `greenway_hit` — which expected greenway was found (or null)

A typical tuning loop:
1. Run harness — note which routes fail and why
2. Adjust factors in `routing/costing-overrides.json` and sync `routing/conf/graph.lua`
3. Rebuild Valhalla tiles: `docker compose up --build` (or run `npm run build:graph` then restart)
4. Re-run harness and compare `tests/results/` timestamps
