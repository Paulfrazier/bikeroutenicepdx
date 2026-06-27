# Pickup note — make the routed line match the overlay color (Plan 2)

**Status:** PLANNED, not started. Pick this up **after** the in-flight coloring
work (`render-class.ts` / `friendliness.ts` matcher tuning — the "name-aware
facility rescue" / "widen facility-rescue radius" line of commits) has **landed
and settled**. Doing it before that means forking the matcher mid-flight and
re-porting later.

Written 2026-06-27. Separate from the A6 self-build routing ship (that's done +
live; see `CHANGE_INVENTORY.md` §C). This is a coloring/UX consistency fix only —
no routing or tile changes.

---

## The symptom
On the map overlay, NE 7th now renders **orange (`caution`)** — correct, looks
great. But when you **route** over 7th, the drawn route line shows **red/white
(`busy`)** instead. The route color doesn't match the map beneath it.

## Root cause
There are **two** classifiers reading the *same* baked `rclass` from the *same*
`bike-network.geojson`, but only one is a direct read:

- **Overlay** — `web/src/components/Map.tsx` layers `bike-network-shared` (~L556)
  and `bike-network-solid` (~L573) paint each feature **directly** by
  `["get","rclass"]`. Always exact.
- **Route line** — colored by a runtime **snap**: the route geometry from BRouter
  is matched to the nearest network feature and that feature's class is copied
  onto the route.
  - Web: `App.tsx:623` `toRouteClassFeatureCollection(activeCoords, friendliness.classes)`;
    `friendliness.classes` comes from `classifyRoute()` (`web/src/friendliness.ts:886`,
    via `web/src/hooks/useFriendliness.ts`).
  - iOS: `RouteStore.swift:422` `BikeFriendliness.shared.classify(coords)`
    (`Services/BikeFriendliness.swift:164`).

When the snap **misses** 7th's `caution` feature (BRouter geometry offset, bearing,
or a parallel greenway one block over), it falls back to **`busy`** (the
off-network "on/along a busy arterial" default). Overlay = `caution`, route =
`busy` → mismatch.

## The fix: one classifier, server-side; clients just render it
Classify the route **on the server**, in the **`rclass` vocabulary**, return a
per-segment array, and have web + iOS paint that. Same file + same matcher as the
overlay's source → route color = overlay color by construction, and the web↔iOS
matcher-parity surface disappears.

### Acceptance test
A route along NE 7th yields `segment_classes` containing **`caution`, not `busy`**,
and the line renders orange on **both** web and iOS, matching the overlay.

---

## Implementation

### Phase A — server (collision-free; can start anytime)
1. **`server/src/services/greenway-coverage.ts`** — today `classifyPoint` (L186)
   reads raw `class` (L94) → *coverage* vocab (`DISPLAY_TO_CLASS`, L45). Add an
   **rclass-aware** classifier:
   - index each feature's `rclass` (fallback `class`);
   - port the rich match logic from `friendliness.ts` — bearing-aware match,
     name-aware facility rescue, widened rescue radius, short-run merge — so
     on-network streets like 7th adopt their feature instead of falling to `busy`.
     **This is the actual fix.** A naive nearest-point snap reproduces the bug.
2. **`server/src/services/brouter.ts`** (result assembly ~L168) +
   **`valhalla.ts`** (`RouteResult` L37): add
   `segment_classes: RouteClass[]` (length = `coords.length - 1`). Derive
   `greenway_coverage` (L42/L347) — and any "comfort %" — from the same array so
   metrics can't disagree with the line color.
3. **`/match`** path (drag-to-reshape; `valhalla.ts:526` builds steps via
   `dominantClass`) — return `segment_classes` too, so the drag preview is
   server-colored and needs no client snap.
4. Server test: route over NE 7th → `segment_classes` includes `caution`,
   excludes `busy`. Regression lock for this bug.

### Phase B — clients (touches the in-flight files; do AFTER they land)
First **port the *final* `friendliness.ts` matcher** into the Phase-A server
module (so we capture the settled tuning, not a mid-flight copy). Then:
5. **Web** — `useFriendliness.ts` / `App.tsx:623`: render `result.segment_classes`
   directly; retire `classifyRoute()` for the authoritative line (keep a thin
   optimistic preview only if a pre-`/match` flash is unacceptable). Add
   `segment_classes` to `web/src/types.ts`. `Map.tsx` route paint already colors
   by `class` from the shared map → unchanged.
6. **iOS** — decode `segment_classes` (`Models/GeoJSON.swift:44`,
   `Models/SnappedRoute.swift:14 routeClasses`); `RouteStore.swift:422` uses them
   instead of `BikeFriendliness.shared.classify()`. `Extensions/MKPolyline+Kind.swift`
   rendering unchanged. The Swift **matcher** leaves the route path.
7. **`scripts/check-parity.ts`** — matcher logic leaves the clients, so parity
   shrinks to the **color maps** only (web `ROUTE_CLASS_COLORS` `friendliness.ts:89`
   ↔ iOS `RouteClass.color` `BikeFriendliness.swift:27`). Update the guard.

---

## Gotchas
- Keep `greenway_coverage` (greenway share) distinct from the web "coverage"
  badge (fraction **not** `busy`) — they're different metrics; derive both from
  `segment_classes` rather than conflating.
- `server/data/bike-network.geojson` must stay byte-identical to
  `web/public/bike-network.geojson` (the `check-data-sync` guard ensures this) —
  that identity is what guarantees the server route classifier and the web overlay
  read the same `rclass`.
- Ship via `ship-bikenice` (server is git-linked → auto-deploy on push; iOS is a
  manual build). The brouter services are unaffected by this change.
