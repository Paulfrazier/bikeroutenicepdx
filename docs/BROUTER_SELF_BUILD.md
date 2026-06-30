# BRouter self-build (Phase 2)

Self-build the BikeRouteNicePDX BRouter segment tiles so the router "sees" the
~2,371 PBOT bike facilities + 286 contraflow fixes from the Phase-1 OSM-gap
backlog (`data/backlog/`) that stock brouter.de tiles lack. Builds **with SRTM1
elevation** so hilly routes still cost correctly.

**Status: DEPLOYED + live-verified, and now the DEFAULT engine for both clients
(2026-06-30).** Self-build runs as the `brouter-selfbuild` Railway service
(`brouter-service-selfbuild/`, committed `segments4/*.rd5` + custom `lookups.dat`),
reachable via `engine=selfbuild` on `/route`. Web and iOS now both default to it
(the prod↔self-build toggle moved into each app's Settings menu for testing). The
A6 work since this doc's original verdict — door-zone "weaklane" avoidance, which
prod's stock tiles structurally can't do (live A/B: 486 m of door-zone lane on
prod → 53 m comfort / 0 m ultra) — plus the bug-fix guard suite is why the old
"not a clear win, do not deploy" call no longer holds. See
`docs/CHANGE_INVENTORY.md` §C for the authoritative deploy state.

The API server still **defaults a missing `engine` to `prod`** (the safe default
for any unknown caller); the clients send `selfbuild` explicitly.

> The "Decision needed / do not deploy" notes further down predate this and are
> kept only as the historical Phase-2 record.

## Build

```bash
bash scripts/build-brouter-tiles.sh           # with elevation (default)
NO_ELEVATION=1 bash scripts/build-brouter-tiles.sh   # faster, hillier routes regress
```

Pure-Java BRouter v1.7.9 map-creator — **no Docker needed** (Docker is only the
Railway *serve* layer). Toolchain: `brew install openjdk@21 osmium-tool` +
`data/brouter-build/venv` with `pyosmium`. ~3 min end-to-end on an 8 GB Mac.

Pipeline (all under `data/brouter-build/`, gitignored):
1. **Extract** — `osmium extract` a *generously buffered* Portland crop
   (`-123.8,44.6,-121.5,46.3`, ~180 km square spanning the W125_N45 **and**
   W125_N40 tiles) from Geofabrik Oregon + Washington, then `osmium merge`. The
   buffer is the fix for the prior self-build's edge-truncated dead-ends — never
   a tight crop. (The app is Portland-only, so a buffered crop is functionally
   complete even though it's narrower than brouter.de's full 5° tile.)
2. **Patch** — `patch-osm-tags.py` (pyosmium read-modify-write) applies the
   backlog's suggested presence + contraflow tags. **100% of 2,657 backlog ways
   matched** in the extract (way ids stable vs the Jun-19 reconciliation).

   ⚠️ **2D-snap guard (added 2026-06-25).** The reconciliation matches PBOT
   facility geometry to OSM ways by lon/lat proximity, which is blind to bridge
   decks and sidewalk-vs-carriageway. On the **Steel Bridge** (a stacked
   double-decker) the lower-deck bike *path* snapped to the UPPER car deck
   (`highway=secondary`, 25 mph) and its `footway=sidewalk` ways; bridge/freeway
   approaches snapped to the motor carriageway. Baking
   `cycleway=track;bicycle=designated;lcn=yes` onto those made the self-build
   router cross the **car deck** of the Steel Bridge and ride freeway/bridge
   carriageways (I-5 Interstate, I-205 Glenn Jackson, Banfield, Hawthorne,
   Morrison, Broadway). `scripts/build-osm-backlog.ts` now drops any presence
   suggestion that lands on (a) a freeway carriageway — any class, (b) an
   off-street/greenway facility on a motor through-road, or (c) a
   `footway=sidewalk`. **263 rows dropped** (backlog 2,371 → 2,108 presence);
   dropped rows are logged to `data/backlog/dropped-mismatches.csv` for upstream
   fixing. Protected cycletracks on arterials (Better Naito, N Lombard, NE 102nd)
   and on-street lanes are kept. Verified: post-rebuild, Big Pink → home crosses
   on `highway=path bicycle=designated` (lower deck), matching prod.
3. **Elevation** — AWS *skadi* 1-arcsec HGT (`N44-46 / W122-125`, no auth) →
   `ElevationRasterTileConverter` → `srtm_12_03.bef` (N45) + `srtm_12_04.bef`
   (N40). Portland metro sits almost entirely in HGT tile **N45W123**.
4. **Map-creator** — `OsmFastCutter → PosUnifier → WayLinker` against the pinned
   v1.7.9 `lookups.dat` / `all.brf` / `trekking.brf` / `softaccess.brf`.

Output: `data/brouter-build/out/W125_N45.rd5` (~13 MB) + `W125_N40.rd5` (~2.5 MB).

## Quality gate (A/B vs prod, profile `safety`/comfort — clean tile-only diff)

The canonical greenway thresholds (`tests/routes/canonical.json`, 0.65–0.70) are
**not met by prod either** (both prod and self-build pass 3/8) — they're
aspirational, so "pass count" isn't the gate. The real signal is the per-OD diff:

| OD | greenway% (mine/prod) | buffered% (mine/prod) | facility% (mine/prod) |
|----|----|----|----|
| 01-sabin-lloyd (flat) | 40 / 40 | 6.7 / 6.7 | 21.3 / 21.3 |
| 08-cully-pdx (flat) | 32 / 32 | 0.2 / 0.2 | 7.8 / 7.8 |
| 03-hawthorne-ohsu (hill) | **23 / 62** | **13.5 / 2.9** | **17.9 / 11.2** |
| 05-beaumont-psu (hill) | **61 / 77** | **13.4 / 6.6** | **20.7 / 18.5** |
| **avg (8 ODs)** | **39.1 / 52.9** | — | **16.9 / 14.7** |

**Reading:** on routes where the patch surfaces no new usable lane, mine ==
prod *exactly* (pipeline + elevation are sound — ascend matches prod within ~4%,
e.g. case03 172 m vs 166 m). Where PBOT buffered/protected lanes exist, the
patched tiles ride **more total bike infrastructure** (facility 16.9% vs 14.7%
avg) by trading away "pure greenway" share. That is the patch working as
designed — it makes lanes like **SE 17th** visible/competitive — but the narrow
greenway-% metric scores it as a regression. Contraflow: SE 16th routes both
directions (~97 m either way); the surrounding grid gives equal alternates so the
patch is correctness-insurance there, not a visible detour fix.

**Decision (resolved 2026-06-30):** "more total bike-infra, less pure greenway"
*is* desirable — the door-zone (A6) safety win settled it. Self-build is now the
default for both `comfort` and `ultra`; the greenway-% A/B above predates the A6
weaklane work and is kept for history. (The original framing — defer, or keep the
patch for `ultra` only — is left below as the Phase-2 record.)

## Deploy (when approved)

Swap the Dockerfile's `curl … brouter.de/…/W125_N45.rd5` for `COPY`ing the built
`out/*.rd5` into `segments4/` (same filenames, same RouteServer args), commit the
tiles (or fetch them in CI), and redeploy the Railway `brouter` service. Reversible.

## Maintenance

Re-run `scripts/build-brouter-tiles.sh` on a PBOT/OSM refresh (regenerate the
backlog first via `scripts/build-osm-backlog.ts`). As OSM absorbs the Phase-3
community edits, brouter.de's weekly rebuild delivers the same data for free and
the self-build can be retired.
