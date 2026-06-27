# Routing logic & color coding — provenance + OSM/PBOT comparison

How a BikeRouteNicePDX route line gets its color, where each label comes from,
and how that compares to native OpenStreetMap (OSM) and PBOT classification.

> **Two separate systems.** *Which path you get* is chosen by the **BRouter**
> engine (`safety` / `safety-ultra` profiles) reading **OSM** data — that's the
> routing. *What color the line is* is decided afterward by a client-side
> classifier (`web/src/friendliness.ts`, mirrored in iOS `BikeFriendliness.swift`)
> that snaps each segment onto bundled data layers — that's the color coding.
> The same classifier colors the static map overlay, so route and overlay never
> disagree.

## How a segment's color is decided (priority waterfall)

Per route-segment midpoint, in order (`friendliness.ts:671-757`):

1. **On a community/personal connector?** → `path` (your fix always wins)
2. **Within 20 m + bearing-aligned (±35°) to a bike-network facility?** → adopt its class
   - …unless you've **personally rated** that street → your rating wins
   - separated facility (protected/greenway/path) → kept; **never** downgraded
   - weak facility (lane/buffered/shared) → uses the baked **`rclass`**: a lane on
     a ≥40 mph street is pre-downgraded to **`busy`** (red); a painted lane on a
     slower arterial or a 4+ lane stroad to **`caution`** (orange)
3. **No facility, but on/along an arterial OR a hazard street?** → `busy` (red)
4. **Otherwise** → `quiet`

Then short runs (<25 m) are smoothed into the preceding run (hysteresis).

## Class → color → provenance → OSM/PBOT comparison

| Class | Color | Style | Legend label | Data layer | Built from | Native OSM tag | Native PBOT label |
|---|---|---|---|---|---|---|---|
| `protected` | `#6D28D9` violet | solid | Protected bike lane | `bike-network.geojson` | PBOT layer 75 `Facility` = **PBL/SIR** | `cycleway=track` / `separated` | Protected Bike Lane / Separated-in-Roadway |
| `greenway` | `#2E9E48` green | solid | Neighborhood greenway | `bike-network.geojson` | PBOT 75 `Facility` = **NG** | `bicycle=designated` + `lcn=yes`, calm street | Neighborhood Greenway |
| `path` | `#B45309` brown | solid | Off-street path | `bike-network.geojson` (+ connectors) | PBOT 75 `Facility` = **TRL** | `highway=cycleway`/`path` | Off-Street Path/Trail |
| `buffered` | `#0891B2` cyan | solid | Buffered bike lane | `bike-network.geojson` | PBOT 75 `Facility` = **BBL/BBBL/SBBL** | `cycleway=lane` + `buffer=yes` | Buffered Bike Lane |
| `lane` | `#F59E0B` amber | solid | Bike lane | `bike-network.geojson` | PBOT 75 `Facility` = **BL/ABL** | `cycleway=lane` | Bike Lane / Advisory |
| **`caution`** | **`#EA580C` orange** | solid | **Bike lane on a busy street — use caution** | baked `rclass` (`arterials` join) | see below | painted lane on `tertiary+` or 4+ lane way | Bike Lane on an arterial/stroad |
| `shared` | `#9CA3AF` gray | **dashed** | Shared roadway | `bike-network.geojson` | PBOT 75 `Facility` = **ESR** | `cycleway=shared_lane` (sharrow) | Enhanced Shared Roadway |
| `quiet` | `#64748B` slate | solid | Quiet street | *fallback* (matched nothing) | n/a — no facility, not an arterial | residential/living_street, untagged for bikes | (unlabeled local street) |
| **`busy`** | **`#DC2626` red** | **dashed** | **Fast or high-stress road — use caution** | `arterials` + `speeds` + `high-crash`, or baked `rclass` | see below | `highway=primary/secondary/tertiary`, `maxspeed` | High Crash St / posted speed / arterial |
| `connector` | `#0d9488` teal | solid | Your fix | personal + `community-fixes.geojson` | hand-drawn | n/a | n/a |

The bake (`scripts/lib/render-class.ts`) splits a stressful *mapped* lane into two
tiers — both leave the facility's geometry but recolor it:
- **`busy`** (red) — a weak lane (lane/buffered/shared) on a **≥40 mph** street
  (`MIN_FAST_MPH=40`). The danger signal.
- **`caution`** (orange) — a plain unbuffered lane on a slower **arterial**, or any
  unprotected facility on a **4+ lane stroad** (`MIN_STROAD_LANES=4`, e.g.
  Foster/Powell; catches NE/SE 7th, Irving, 16th). Both go to the same tier so a
  plain lane and a buffered lane on the *same* stroad never split colors. Counts
  toward route comfort-coverage (only `busy` is excluded).

The **red `busy`** is also reached at **runtime** — a segment with **no mapped
facility** that sits on/along an **arterial** or a **hazard** street → red
(`friendliness.ts:744-753`).

## Source layers — who owns each label

| Layer file | Source / owner | Endpoint & filter | Role in coloring |
|---|---|---|---|
| `bike-network.geojson` | **PBOT** (PortlandMaps Open Data) | `MapServer/75`, `Status='ACTIVE'`, field `Facility` | The 6 facility classes (the "nice" colors) |
| `arterials.geojson` | **OSM** (Overpass) | `highway ∈ motorway/trunk/primary/secondary/tertiary`, Portland bbox | `busy` arterial vs `quiet` street |
| `speeds.geojson` | **PBOT** | `MapServer/225` "Speed Limits", `SpeedLimit ≥ 30` | Hazard layer + drives the ≥40 mph `rclass` bake |
| `high-crash.geojson` | **PBOT** | `MapServer/1429` "High Crash Streets", `Bicycle='Y'` | Hazard layer → `busy` |
| `greenways.geojson` | **PBOT** (ArcGIS NG layer) | legacy standalone overlay | display-only; superseded by layer 75 |
| `community-fixes.geojson` | **You / community** | bundled hand-drawn | `path` / connector |

## Key takeaways on OSM vs PBOT labeling

- **The 6 facility classes are PBOT's, not OSM's.** They map 1:1 from PBOT's
  `Facility` codes (PBL/NG/TRL/BBL/BL/ESR), *not* from OSM `cycleway=*`. The
  overlay reflects PBOT's official classification, which can diverge from how the
  same street is tagged in OSM.
- **The `busy`/`quiet` split is OSM's** (`highway=*` class via Overpass), plus
  PBOT speed + high-crash overlays. This is the **mismatch source**: where PBOT
  maps *no* facility but OSM classes the street as an arterial, the segment goes
  red even if the street is calm in reality (e.g. SW 5th transit mall, NW Couch).
- **BRouter (the actual router) sees only OSM** — `lcn` route relations and
  `maxspeed`. It knows nothing about PBOT `Facility` codes. So the engine picks a
  path on OSM data, then the classifier recolors it against PBOT data: two label
  sources on one line, which is why a chosen route can still show red stretches.
- **No data layer carries building entrances, garage doors, or bike-rack
  locations.** Routes target the geocoded *street-address point*, not a rack.

## Worked example — house → Portland City Grill (Big Pink)

- **NW Couch / SW 5th show red** because PBOT maps no bike facility on them; OSM
  classes both as `tertiary` arterials → `busy`. (Couch *is* a greenway for a few
  blocks near the Burnside bridgehead; beyond that stub it falls through to red.)
- The router approaches downtown on **SW Oak St** (PBOT **buffered** bike lane,
  cyan) and **SW Stark** (buffered) — the genuinely low-stress streets — rather
  than **SW Pine** (no mapped facility, OSM `tertiary` → would be red).
- The destination pin geocodes to a *street point* near SW 5th, so the final
  block lands on 5th (red), not at the building's actual bike racks.

**Softening a harsh red:** (1) personal tap-to-rate override on the named street,
(2) draw a community connector over the stretch (classes as `path`), or (3) fix
the source — add the segment to PBOT's network / OSM.
