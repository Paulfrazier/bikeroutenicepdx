# PBOT facility-steering — prototype + measurement (NOT deployed)

**Status: measured, NOT wired into prod.** Like the engine bake-off, this is a
documented experiment. Prod `/route` is unchanged (plain `getRouteBrouter`).

## Question
BRouter routes on stock OSM (brouter.de `segments4`); it never sees PBOT's facility
classification, so it can avoid *built* buffered/protected lanes that OSM tags as busy
tertiary streets (e.g. SE 17th Ave, `highway=tertiary maxspeed=30 oneway=yes`). Can we
steer it onto those lanes using PBOT data — without rebuilding the graph or editing `.brf`?

## Approach (selection layer, no graph/profile changes)
For one request, generate candidates and re-rank by a PBOT-aware score:
- **Candidates:** BRouter `alternativeidx` 0..2 **+** "facility-seeking" candidates that
  inject mandatory vias onto the strongest PBOT lane lying *along* the OD corridor.
- **Corridor finder** (`facilitiesInCorridor`, `greenway-coverage.ts`): project every
  buffered/protected segment onto the OD axis, keep ones within ±350 m and roughly
  parallel, cluster by offset to isolate one street, return the best band's ordered "spine".
  Vias = spine midpoint / thirds / quarters.
- **Score** (`green*greenwayCov + fac*facilityCov − dist*detour`, `green ≥ fac`), with a
  detour cap (`min(1.25×, +800 m)`) discarding wrong-way one-way loops.
- Reusable helpers added (additive, prod-safe): `fetchBrouterGeometry` (brouter.ts),
  `facilitiesInCorridor` + `facilityMeters` (greenway-coverage.ts).

Harness: `scripts/compare-facility.ts` (A = plain idx0, B = best candidate). Run against
the live brouter-service. Geometry-only candidates; the prototype scorer omits the
forbidden-street penalty (no step names) — restored if integrated.

```
BROUTER_URL=https://brouter-selfbuild-production.up.railway.app PREFERENCE=ultra \
  npx tsx scripts/compare-facility.ts
```

## Findings (prod brouter-service, 2026-06-23)

> The stock `brouter` service these findings were measured against was retired on
> 2026-08-26 (it cost ~$3.50/mo in idle RAM and both apps had defaulted to
> `engine: "selfbuild"` since 2026-06-30). The command above now points at the
> self-build engine, whose profiles carry the weaklane penalty — so re-running it
> will not reproduce these numbers exactly.

**`comfort` (safety profile): facility-steering ≈ no benefit.** BRouter `safety` already
rides buffered lanes (SE 17th: 38% buffered; St Johns→Downtown: 45%). Facility vias added
≤1% buffered. The only `comfort` swaps came from *alternatives*, which sometimes trade
greenway for distance (Beaumont→PSU 77%→73% greenway for −7.7% distance) — needs care.

**`ultra` (safety-ultra): facility-steering helps in specific cases.** `ultra` hard-avoids
buffered lanes, and steering recovers them, sometimes for free/better:

| OD | A (idx0) buffered | B buffered | greenway A→B | detour | winner |
|----|----|----|----|----|----|
| **Hawthorne→Sellwood** | **0.0%** | **17.8%** | 57.9%→59.9% | **−12.3% (shorter!)** | fac-mid |
| Beaumont→PSU | 6.6% | 11.9% | 77.4%→74.6% | +2.6% | idx2 |
| Hawthorne→OHSU | 8.3% | 2.9% | 45.6%→61.7% | −1.0% | fac-mid |
| Clinton→Westmoreland | 24% | 24% | 60%→60% | 0% | idx0 (held) |
| (most canonical ODs) | — | unchanged | unchanged | 0% | idx0 |

The headline: on Hawthorne→Sellwood, baseline `ultra` took a **longer** path (7.18 km) to
**completely avoid** SE 17th (0% buffered); steering it onto the lane gave a **shorter**
route (6.30 km) with **more** greenway. That is the user-reported bug, fixed.

**No regressions:** the detour cap + `green ≥ fac` weighting held — no OD got a big detour
or greenway collapse from a facility candidate. Wins are concentrated in `ultra` and in a
minority of ODs (the OD must have a good lane along the direct line that the profile skipped).

## Verdict
The core bet — *a forced via keeps BRouter on the lane at acceptable detour* — is
**confirmed**. But the aggregate win is **modest and `ultra`-specific**, and it costs
~5–6× BRouter calls/request plus via-injection occasionally reshaping routes in
unintended-but-OK ways. Recommendation: if shipped, do it **`ultra`-only, flag-gated**
(`FACILITY_SELECTION`), default-off, since that's where the measured benefit lives. Otherwise
leave as a documented prototype.

## Files
- `scripts/compare-facility.ts` — harness (+ inline prototype scorer)
- `server/src/services/brouter.ts` — `fetchBrouterGeometry` (additive)
- `server/src/services/greenway-coverage.ts` — `facilitiesInCorridor`, `facilityMeters` (additive)
- `tests/results/fac-*.geojson` — A/B/spine geometries (eyeball on geojson.io)
