# Engine bake-off (side project — NOT in production)

> **Status: committed but inert.** Every file in this folder is part of an
> offline experiment. **Nothing here is imported by the live request path** —
> `POST /route` stays **BRouter-only** (`server/src/routes/route.ts` →
> `getRouteBrouter`). It lives in the repo (instead of as uncommitted working-tree
> dirt) so it's preserved, discoverable, and typechecked. The only rule: **don't
> re-wire `routes/route.ts` to `bakeoffRoute`.**

An experiment to see whether routing through multiple engines and picking the
best route per request beats the single self-hosted BRouter engine. **Conclusion:
it doesn't meaningfully — so this is kept as an offline experiment and is
deliberately not wired into the live server.**

## The idea

Race every available engine in parallel, score each by the project's existing
greenway-coverage metric (+ forbidden-arterial + detour penalties, weighted by
the comfort↔fast preference), return the winner plus runners-up as alternatives.
Different OD pairs can favor different engines, so in principle a per-request
bake-off always serves the best route.

Engines:
- **Valhalla**, **BRouter** — self-hosted, unlimited, no key (live in
  `server/src/services/`).
- **ORS** (`cycling-regular`), **GraphHopper** (`bike`) — free public APIs, keyed
  (no billing). See `reference_ors_heigit_migration` for the ORS HeiGIT URL +
  profile gotchas.

## What we found (2026-06-20)

Coverage = share of route on greenway-equivalent infra (off_street/greenway/protected).

| Route | 🥇 | 🥈 | 🥉 |
|-------|----|----|----|
| Home → Trackers Earth SE | **BRouter 72.6%** | GraphHopper 46.1% | ORS 17.8% |
| Home → Belmont H Mart | **GraphHopper 78.1%** | BRouter 76.8% | ORS 50.6% |

- **BRouter is 1st or within ~1 point every time** — and it's the free, unlimited,
  no-ToS engine.
- **GraphHopper** only ever ties/edges BRouter (won H Mart by 1.3 pp; lost Trackers
  by 26 pp). Marginal.
- **ORS `cycling-regular`** is not greenway-preferring — lost both badly, and
  averaged ~40% across the 8 canonical ODs vs BRouter's ~59%.

Takeaway: the best engine is the one already self-hosted for free. The paid-tier
keys buy a coin-flip tie at best, so the added dependencies/quota/ToS aren't worth
shipping. Hence: keep the code, don't deploy it.

## Files

In this folder (`server/src/experiments/engine-bakeoff/`):
- `bakeoff.ts` — per-request orchestrator (fan-out, score, winner + alternatives).
  Ready to wire; currently imported by nothing.
- `ors.ts`, `graphhopper.ts` — engine clients.
- `route-scoring.ts` — coverage + forbidden + detour scoring.
- `route-synth.ts` — shared bare-geometry → RouteResult (steps + coverage) helper,
  used by the ORS/GraphHopper clients.
- `engine-skip.ts` — non-fatal "drop this engine" signal (missing key / HTTP 429).

Elsewhere:
- `server/src/config.ts` — `orsApiKey`/`graphhopperApiKey`/`orsUrl`/`graphhopperUrl`
  env reads (inert unless the bake-off is run).
- `scripts/compare-engines.ts` — the offline runner (`npm run compare:engines`).
  Kept under `scripts/` alongside the other tsx runners; it imports the engines
  from this folder.

## Run it

```bash
# Valhalla + BRouter reachable (local Docker, or point *_URL at deployed services).
ORS_API_KEY=…  GRAPHHOPPER_API_KEY=…  npm run compare:engines

# Single OD instead of the canonical set:
OD_FROM="-122.6434,45.5497" OD_TO="-122.6505,45.4942" \
  OD_NAME="Home → Trackers" ORS_API_KEY=… GRAPHHOPPER_API_KEY=… \
  npm run compare:engines
```

Outputs a scored table + per-engine GeoJSON to `tests/results/<od>-<engine>.geojson`
(open `…-all.geojson` on geojson.io to compare lines).

## To activate later (if ever)

1. In `server/src/routes/route.ts`, swap `getRouteBrouter(...)` →
   `bakeoffRoute(...)` (import from `../experiments/engine-bakeoff/bakeoff.js`).
2. Set `ORS_API_KEY` / `GRAPHHOPPER_API_KEY` in the server env (Railway).
3. Re-add the optional `engine` / `alternatives` fields to the web/iOS response
   types if you want to show the winning engine (they were reverted to keep the
   client unchanged).
