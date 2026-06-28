# Pushing the backlog to OpenStreetMap

This repo's routing is only as current as its inputs. The **self-built BRouter
engine** (`engine: "selfbuild"`) gets new PBOT facilities immediately via the
supplement source (see [data-sources.md](data-sources.md) and
`data/pbot-supplement/`). The **default `prod` engine serves stock brouter.de
tiles**, which know nothing but upstream OSM — so the *only* way a 2024-2026 build
reaches default routing is to get the data into OpenStreetMap itself. This doc is
that workflow.

> The osmChange/`.osc` patch mentioned in `scripts/build-osm-backlog.ts` is
> **aspirational — not implemented**. We submit via the iD/JOSM + MapRoulette
> flow below, off the artifacts that backlog builder *does* write.

## Where the worklist comes from

`npm run build:backlog` (after `build:graph` → `reconcile`) writes to
`data/backlog/`:

| File | Use |
|---|---|
| `osm-gaps.csv` | Flat worklist — one row per OSM way missing a bike tag PBOT/supplement asserts. Columns: `gap,osm_way_id,name,pbot_class,suggested_tags,length_m,lat,lng`. |
| `osm-gaps.geojson` | Same gaps as a FeatureCollection. **Load as a layer in iD or JOSM** to edit each way in place. |
| `maproulette.geojson` | Newline-delimited tasks (`{osmid:"way/<id>", gap, name, instruction, suggested_tags}` + geometry) — upload as a MapRoulette challenge for community editing. |
| `dropped-mismatches.csv` | Suggestions the snap-guard rejected (facility landed on a freeway/sidewalk/motor road). **Do not edit these** without re-checking — they're likely bad matches, not real gaps. |

The supplement entries (SW 4th, Montavilla, Stark, the greenways, the hardening
upgrades) flow into these files automatically once `build:supplement` has run and
`build:graph` has merged them — they appear as `presence` gaps because OSM lacks
the tags they assert.

## Editing workflow (per corridor)

1. **Pick a corridor** from `osm-gaps.csv` (e.g. grep `4th Avenue`, `Stark`,
   `Tillamook`). Cross-reference the matching row in
   `data/pbot-supplement/new-builds.manifest.json` for the authoritative `from`/`to`
   limits, `source_url`, and `completed` date.
2. **Open the area** in [iD](https://www.openstreetmap.org/edit) (web) or **JOSM**.
   In JOSM, load `osm-gaps.geojson` as a layer so the target ways are highlighted.
3. **Verify on the ground truth first.** Open the PBOT `source_url` and recent
   imagery. `suggested_tags` is a *starting point*, not a blind apply — confirm the
   facility type, extent, and side of street before tagging.
4. **Apply tags** per the facility type (below).
5. **Changeset hygiene:**
   - `comment` = what you did, e.g. `Add protected bike lane on SW 4th Ave (PBOT, opened 2025-12)`
   - `source` = `City of Portland PBOT — <project name>`
   - Add the `source_url` and completion date in the changeset description.
   - One changeset per corridor/project; don't bundle unrelated areas.
6. **After it's accepted upstream:** the next `npm run fetch:osm` (Geofabrik) carries
   it, the way drops out of `osm-gaps.csv` on the next `build:backlog`, and the
   matching supplement row can be **retired** from the manifest (delete it — PBOT
   GIS / OSM now cover it).

## Per-facility tagging

Mirrors `SUGGESTED_TAGS` in `build-osm-backlog.ts` and `CLASS_TAGS` in
`build-graph.ts`. Tag the OSM way (or split it to the project limits first).

| Supplement `class` | Core OSM tags | Notes |
|---|---|---|
| `greenway` | `bicycle=designated`, `lcn=yes` | Add `maxspeed=20 mph` where signed. Speed bumps → `traffic_calming=bump` nodes. Diverters/crossings → their own nodes. |
| `protected` | `cycleway=track` (or a separate `highway=cycleway` way) | Two-way track on a one-way street ⇒ `oneway:bicycle=no`. Concrete hardening ⇒ `cycleway:separation=kerb` (replacing `cycleway:separation=flex_post`). |
| `lane` / `buffered` | `cycleway=lane` | Buffered ⇒ `cycleway=buffered_lane` or `cycleway:buffer=yes`. Advisory lanes (e.g. NE 43rd) ⇒ `cycleway=lane` + `cycleway:lane=advisory`. |
| `path` (off-street) | `highway=cycleway`, `bicycle=designated`, `lcn=yes` | Separate geometry, not a road tag. |

**New signals / crossings** that came with these projects are nodes, not way tags:
- Kelly Plaza signal (NE Sandy @ ~42nd), Brentwood-Darlington signal (SE 82nd @
  Ogden/greenway crossing) → `highway=traffic_signals`, and where a marked bike/ped
  crossing → `crossing=traffic_signals` on the crossing node.

### Corridor-specific cautions (from the manifest `note` fields)
- **SW 4th Ave** — west-side lane on a one-way street. Confirm bike directionality
  before setting `oneway:bicycle` either way.
- **Concrete hardening** rows (NE 102nd, NW Naito, NE Couch, SW Madison) are usually
  *already* protected in OSM/PBOT GIS — the edit is the `cycleway:separation=kerb`
  refinement, not a new facility. Don't duplicate geometry.
- **NW Naito @ Hoyt** and **NE 115th @ Fremont** had no shared OSM node with their
  cross-street — the supplement clipped them by bbox, so double-check the extent
  against the PBOT page when editing.
- **60s Greenway** — manifest captures the SE 60th spine only; the route also jogs
  onto SE 64th. Edit both on the ground.

## Community path (MapRoulette)

For corridors you'd rather crowd-source: upload `data/backlog/maproulette.geojson`
as a new MapRoulette challenge. Each line is a self-contained task with an
`instruction` and `suggested_tags`. Set the challenge `source`/instructions to point
back at the PBOT projects so editors verify before applying. `pbot_calm` /
recommended-route gaps are deliberately excluded from this file (router-only
preference, not real OSM facts).
