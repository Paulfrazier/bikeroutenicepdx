# BikeNice: add PBOT "Shared Roadway" (SR_LT / SR_MT) calm streets

## ADDENDUM (2026-06-28) — calm_mod reclassified as higher-stress
PBOT's own map taxonomy puts SR_LT and SR_MT in DIFFERENT comfort tiers: SR_LT is
low-stress, SR_MT ("Shared Roadway with Wider Outside Lane", moderate/higher
traffic) is higher-stress. Data agreed (calm_mod is 84% on arterials vs calm's
27%). So `calm_mod` was:
- **recolored** olive `#A3B18A` → goldenrod `#CA8A04` (warm, off the green family),
  still dashed — web + iOS.
- **dropped from `calm_coverage`**: greenway-coverage.ts `DISPLAY_TO_CLASS` now
  maps `calm_mod` → `standard` (was `calm`). Only SR_LT counts as calm.
- Routing preference is UNCHANGED — the mild `pbotcalmbonus` (−0.05 SR_MT) in
  the BRouter profiles stays; this addendum is display + coverage only.
Same change also merged the caution lane gradient (caution2/3 → one orange
`caution`; caution4 → red). See docs/ROUTING_COLOR_LOGIC.md.

## STATUS (resumed 2026-06-27)
- [x] Surface 1 DATA — export-bike-network.ts pulls layer-4 SR_LT(4199)/SR_MT(534),
      tags calm/calm_mod, appends to all 3 bike-network.geojson copies. VERIFIED:
      SE 16th south of Ladds now present as calm/SR_LT, rclass=calm.
- [x] render-class.ts — calm/calm_mod added to STRONG (never speed-down-rated).
- [x] Surface 2 WEB — friendliness.ts (RouteClass + colors #7FB069/#A3B18A + dashed
      + normalizeClass), Map.tsx legend rows + overlay dashed layer.
- [x] Surface 3 iOS — BikeFriendliness.swift (RouteClass) + MKPolyline+Kind.swift
      (BikeClass: label/color/width/dashed/zPriority/legendOrder).
- [x] Surface 4 SERVER — greenway-coverage.ts calm NetworkClass + CALM_CLASSES;
      brouter.ts reports calm_coverage SEPARATELY (not folded into greenway).
- [x] GUARDS — npm run check green (parity 13 colors, data sync, contraflow).
- [~] Surface 5 ROUTING — CODE COMPLETE (graded custom-tag approach, user-chosen):
      · build-graph.ts: calm/calm_mod NormalizedClass + CLASS_TAGS pbot_calm marker
        + classPriority (facilities always outrank calm).
      · build-osm-backlog.ts: separate calm emission path → osm-gaps.csv, EXCLUDED
        from MapRoulette/upstream (pbot_calm is a local router marker).
      · lookups.dat: pbot_calm low|moderate added to committed + build copies (identical).
      · safety-comfort.brf + safety-ultra.brf: graded pbotcalmbonus (-0.10 SR_LT /
        -0.05 SR_MT) on residential/living/unclassified, so calm<greenway, SR_MT<SR_LT.
      · patch-osm-tags.py: generic, no change needed.
      REBUILD DONE + A/B VERIFIED (2026-06-27): build:graph (calm 2749 / calm_mod 421
      joined) → backlog (3082 calm gaps, pbot_calm marker, excluded from MapRoulette)
      → build-brouter-tiles.sh (5191 ways patched 100%, pbot_calm baked into out/*.rd5).
      A/B old vs new tiles (local RouteServers, safety-comfort):
        · cost on a calm way: 1150 → 1050 (greenway ~1000 < calm 1050 < plain res 1150) ✓
        · 62 short inner-SE trips: calm-share 18.0% → 20.3%, +11.9% calm distance,
          5/62 routes shifted, total-distance penalty −0.35% (net neutral).
      NOTE: bonus STRENGTH (−0.10/−0.05) lives in the .brf (read at serve time), so it
      can be retuned WITHOUT a tile rebuild — only the pbot_calm TAG needed the rebuild.
      HELD before deploy (user choice). To deploy: copy data/brouter-build/out/*.rd5 →
      brouter-service-selfbuild/segments4/, commit, railway up brouter-selfbuild.
- [ ] docs / ship-bikenice.

## Surface 5 decision (why it's not just a tag patch)
Residential streets sit at a FLAT costfactor 1.1 in safety-comfort.brf; the only
standard sub-1.1 lever is lcn=yes, which forces is_ldcr→costfactor 1.0 (== greenway).
So a GRADED "calm < greenway, SR_MT < SR_LT" preference REQUIRES a custom decodable
tag (pbot_calm=low|moderate) threaded through: build-graph.ts (NormalizedClass),
build-osm-backlog.ts (emit calm patch WITHOUT polluting the facility/MapRoulette
backlog), lookups.dat (decode pbot_calm), both .brf profiles (graded discount),
then rebuild W125_N45/N40.rd5 + redeploy brouter-selfbuild. Toolchain + recon
inputs confirmed present locally.

## Goal
Pull PBOT recommended shared-roadway streets into the bike map + router so e.g.
SE 16th south of Ladd Circle shows up. Scope (user-confirmed): **coloring + routing
preference**, classes **SR_LT + SR_MT**.

## Source data (verified)
- Service: `https://www.portlandmaps.com/arcgis/rest/services/Public/PBOT_RecommendedBicycleRoutes/MapServer/4`
  (layer 4 = "Bike Routes (large scale)"; layer 5 = small-scale generalization — use 4)
- Queryable: maxRecordCount 2000, supportsPagination true, returns geometry, outSR=4326
- Field `ConnectionType`. Pull ONLY: `SR_LT` (4,199 segs) and `SR_MT` (534 segs).
  Ignore NG/BL/BBL/MUP/etc — those already come authoritatively from layer 75.
- Fields to keep: StreetName, FromStreet, ToStreet, ConnectionType
- SR_LT = "Shared Roadway (Low Traffic)"; SR_MT = "Shared Roadway (Moderate Traffic)".
  These are shared streets with NO physical facility — additive to layer 75.

## Two new display classes
- `calm`     <- SR_LT  (slightly worse than greenway)
- `calm_mod` <- SR_MT  (worse than calm)

## Scoring hierarchy (CONFIRMED 2026-06-26: "Calm beats stroad lanes")
Friendliness order (nicest -> least). User confirmed calm quiet streets outrank
facilities-on-busier-streets, per the "stroad-over-coverage" philosophy:
  1 path
  2 greenway
  3 calm      (SR_LT)      <- just below greenway, ABOVE protected/buffered
  4 protected
  5 buffered
  6 calm_mod  (SR_MT)      <- below buffered, ABOVE painted lane
  7 lane
  8 shared (ESR)
  ...then speed overlays busy/fast at bottom.
Routing: give SR_LT a small preference bonus (less than greenway), SR_MT a smaller
one; never as strong as greenway. Merge priority: real facility > calm > calm_mod.

## Implementation surfaces
1. DATA — `scripts/export-bike-network.ts`
   - add 2nd fetch against layer 4, paginate, classify SR_LT->calm, SR_MT->calm_mod
   - append features into bike-network.geojson (priority: facilities draw over calm)
   - carry `facility` raw code (SR_LT/SR_MT) + name
   - mind `scripts/lib/render-class.ts` (bakeRenderClass / rclass) — give calm classes
     a sane rclass so speed coloring doesn't mark them busy/fast by default
   - writes 3 copies: web/public, ios/.../Resources, server/data
2. COLORING web — friendliness.ts + legend + map style (dim/dashed, subordinate to greenway)
3. COLORING iOS — friendliness.swift + legend + overlay style (mirror web)
4. SERVER — server/src/services/greenway-coverage.ts: add calm/calm_mod to NetworkClass
   + DISPLAY->NetworkClass map; report `calm_coverage` SEPARATELY (do NOT fold into
   greenway_coverage)
5. ROUTING (self-build BRouter) — scripts/build-osm-backlog.ts + build-brouter-tiles.sh:
   add SR_LT/SR_MT as a calm tag-patch with a mild preference; rebuild tiles; A/B verify
   (engine=selfbuild). This is the heavy part (tile rebuild).
6. GUARDS — keep `npm run check` green: check-parity.ts (web<->iOS friendliness),
   check-data-sync.ts (multi-target geojson). Update both for new classes.
7. BUILD_LOG.md entry; consider /ship-bikenice for multi-surface release.

## Notes
- Verified SR_LT and NG render identical white on PBOT's own map -> that's why the
  experience map *looks* like a continuous greenway south of Ladd Circle, but PBOT
  attributes it SR_LT, not NG. Layer 75 (ours) has it NONE/RECOMM. Both agree it's
  not a built greenway.
- Ladd Circle = lat 45.5085, lon -122.6494. ACTIVE greenway on SE 16th bottoms out
  right at the circle (45.5089); SR_LT continues south.
