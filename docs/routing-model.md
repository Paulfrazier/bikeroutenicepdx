# Routing Cost Model

The whole product hinges on this. Default Valhalla bicycle costs treat all roads of a given class equally — a residential street and a 4-lane arterial both score "low traffic" if neither has a bike lane. We override per-edge based on PBOT's authoritative classification.

## Cost factors

Each edge gets a multiplier on its base traversal cost (lower = preferred):

| Class | Factor | Example |
|---|---|---|
| `off_street` | 0.15 | Springwater Corridor, Eastbank Esplanade, Marine Drive path |
| `greenway` | 0.20 | NE Going, SE Lincoln, N Willamette |
| `protected` | 0.40 | Naito Pkwy protected lane, NE Multnomah |
| `buffered` | 0.60 | NE Williams (buffered sections) |
| `standard` | 0.80 | Most striped bike lanes |
| `residential` (no infra) | 1.00 | Baseline — quiet residential street |
| `collector` | 2.50 | NE 33rd, SE 39th |
| `arterial` | 5.00 | Sandy, MLK with bike lane |
| `arterial_no_bike` | 10.00 | Effectively avoid — Powell w/o bike lane, Burnside, 82nd |

Plus per-feature penalties:
- Difficult crossing (PBOT-flagged point feature): **+60s**

## Where these come from

`bicycle_network_class` is an attribute we inject onto OSM ways during `scripts/build-graph.ts` based on spatial join with PBOT's bicycle network layer. Valhalla's costing config (`routing/costing-overrides.json`) reads it.

## Implementation note

If Valhalla's stock bicycle costing doesn't accept arbitrary new attribute keys, the fallback is to translate `bicycle_network_class` into existing per-edge costing levers: `bicycle_safety` weights, `cycleway` tag overrides, and `surface` factors. This is decided during Phase 2 step 6 of the implementation plan.

## Tuning

The factors above are starting points. Validate against `tests/routes/canonical.json`:
- Average greenway/path/protected coverage across all 8 routes should be **>70%**
- No route should put **>200m** on known-bad streets (Sandy, Powell, Cesar Chavez, MLK, Burnside)

Adjust factors and re-run `npm run test:routes` until both gates pass.

## What "greenway coverage" means

Sum of distance traversed on edges where `bicycle_network_class ∈ {off_street, greenway, protected}`, divided by total route distance.
