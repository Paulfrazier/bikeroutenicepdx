# Change inventory & rollback notes

A map of everything currently uncommitted in the tree, grouped by feature, with
how to **unwind** each one independently — so things can be culled later without
unpicking the rest. Written 2026-06-24.

Two buckets: **(A)** this session's speed-aware coloring + routing work, and
**(B)** pre-existing uncommitted work that was already in the tree (a different
effort) and is entangled with A only at deploy time.

---

## A. Speed-aware coloring + routing (this session)

Three independent sub-features. Each can be reverted on its own.

### A1 — Color: fast unprotected lanes → red
A lane (buffered/lane/shared) on a ≥40 mph street (PBOT speeds) is baked to render
class `busy` and drawn red on both the overlay and the route. See
`docs/SPEED_ROUTING.md`.

| | |
|---|---|
| **New files** | `scripts/lib/render-class.ts`, `scripts/bake-render-class.ts` |
| **Edited** | `scripts/export-bike-network.ts` (calls the bake), `package.json` (`bake:render-class`), `web/src/friendliness.ts`, `web/src/components/Map.tsx`, iOS `BikeFriendliness.swift` / `BikeNetworkLoader.swift` / `MKPolyline+Kind.swift` |
| **Data** | `rclass` property added to all 3 `bike-network.geojson` (web/ios/server) |
| **Ships via** | Web (Vercel) + iOS. **Not deployed.** |
| **Unwind** | `git checkout -- web/src/friendliness.ts web/src/components/Map.tsx scripts/export-bike-network.ts package.json ios/.../BikeFriendliness.swift ios/.../BikeNetworkLoader.swift ios/.../MKPolyline+Kind.swift web/public/bike-network.geojson ios/.../Resources/bike-network.geojson server/data/bike-network.geojson` and delete `scripts/lib/render-class.ts`, `scripts/bake-render-class.ts`. All consumers fall back to `class` if `rclass` is absent, so a partial revert degrades gracefully. |
| **Tune (not cull)** | `MIN_FAST_MPH` in `scripts/lib/render-class.ts`, then `npm run bake:render-class`. |

### A2 — Routing: `ultra` avoids 45+ mph
`speedpenalty` in `safety-ultra` (45 → +0.4, 50/55+ → +0.7).

| | |
|---|---|
| **Edited** | `brouter-service/profiles/safety-ultra.brf`, `brouter-service-selfbuild/profiles/safety-ultra.brf` |
| **Ships via** | Railway redeploy of the brouter service(s). **Test router: deploying. Prod: not done.** |
| **Unwind** | Remove the `assign speedpenalty` block **and** the `add speedpenalty` line from both `.brf` files, then redeploy. |
| **Tune** | The two penalty numbers (see `docs/SPEED_ROUTING.md` §6 for measured strength trade-offs). |

### A3 — Routing: `comfort` also avoids 45+ (fork)
New `safety-comfort` profile = stock BRouter `safety` + the same penalty; `comfort`
now maps to it instead of stock `safety`.

| | |
|---|---|
| **New files** | `brouter-service/profiles/safety-comfort.brf`, `brouter-service-selfbuild/profiles/safety-comfort.brf` |
| **Edited** | both `Dockerfile`s (COPY the profile), `server/src/services/brouter.ts` (`comfort → safety-comfort`) |
| **Ships via** | Railway redeploy + a server redeploy (so the new mapping is live). **Test router: deploying. Prod: not done.** |
| **Unwind** | In `brouter.ts` set `comfort: "safety"` again (instant revert to stock — the profile can stay in the image unused). To fully remove: drop the COPY lines + delete the two `.brf` files. |

### A4 — Routing: avoid 4-lane no-bike-lane stroads (both safety tiers)
A `stroadpenalty` makes any way with `lanes>=4` and **no real bike lane**
(painted `cycleway=lane`/protected `track`, or `bicycle_road`/`cyclestreet`/
`bicycle=designated`) effectively no-go: **+50** additive to `costfactor`,
regardless of posted speed. This catches the 35–40 mph 4-laners (Holgate, Powell,
82nd, Sandy) that sit *below* A2's 45 mph `maxspeed` bucket and are tagged only
`bicycle=yes`. Crossing such a road perpendicularly is unaffected — `costfactor`
is per-way, so it only fires when riding *along* the stroad.

| | |
|---|---|
| **Edited** | `brouter-service/profiles/{safety-ultra,safety-comfort}.brf` + the `brouter-service-selfbuild/profiles/` copies (kept identical) |
| **Adds** | `hasrealbikelane` + `ismultilane` + `stroadpenalty` assigns, and one `add stroadpenalty` line in `costfactor` (right after `add speedpenalty`) |
| **Data** | None — `lanes` is already in BRouter's stock `lookups.dat`; verified encoded in **both** brouter.de (prod) and self-build tiles. No tile rebuild. |
| **Ships via** | Railway redeploy of the brouter service(s). **DEPLOYED 2026-06-24 to BOTH `brouter` (prod) + `brouter-selfbuild`.** |
| **Verified** | Local A/B (new vs. a `-stroadpenalty`-removed control) on the Holgate corridor: control rides ~600–850 m of 4-lane no-lane road; new profile = **0 m**, at a ~15% distance detour. Crossing-only OD unchanged. **Live-confirmed post-deploy:** prod `safety-ultra` 5343→6138 m on that OD; end-to-end `POST /route` returns `distance_m:6138`; N→S crossing OD unchanged at 1829 m. |
| **Unwind** | Remove the `hasrealbikelane`/`ismultilane`/`stroadpenalty` assigns **and** the `add stroadpenalty` line from all four `.brf` files, then redeploy. |
| **Tune** | The `50` (penalty strength) and the `lanes=4|5|6|7|8` threshold (`8` = the bucket folding raw lanes 8–25; 9–25 are not valid profile tokens). |

### A5 — Routing: avoid >25 mph streets with no PHYSICAL bike lane (both tiers)
A `fastnolane` penalty fills the gap between A1's 25 mph calm line and A2/A3's
45 mph `maxspeed` penalty and A4's 4-lane stroad penalty: a **2–3 lane 30–40 mph
collector** with no painted lane (and a **`bicycle=designated`-but-unlaned**
arterial like **NE Halsey** around NE 70th) slipped past all three. Graduated
additive penalty by posted speed: **30 mph → +2, 35–45 mph → +3, 50+ mph → +5**.
Keyed off a NEW `hasphysicalbikelane` (cycleway `lane`/`track`, `bicycle_road`,
`cyclestreet`) that — unlike A4's `hasrealbikelane` — **excludes
`bicycle=designated`**, so the "designated" tag can't whitewash a no-lane
arterial. Per-way, so crossing is unaffected. Values are deliberately gentle so
the router *yields* where there's no calm alternative (e.g. the 38 mph airport
approach on Cully→PDX rides through rather than detouring 4.7 km).

| | |
|---|---|
| **Edited** | `brouter-service/profiles/{safety-ultra,safety-comfort}.brf` + the `brouter-service-selfbuild/profiles/` copies (kept identical) |
| **Adds** | `hasphysicalbikelane` + `fastnolane` assigns, and one `add fastnolane` line in `costfactor` (right after `add stroadpenalty`) |
| **Data** | None — `maxspeed` + `cycleway` are in BRouter's stock `lookups.dat`. No tile rebuild. NOTE: `maxspeed` must match a **canonical** bucket token (first value on its `lookups.dat` line: 30 mph=`50`, 35-40=`60`, 45=`70`, 50/55/60-65/70/75/80 mph=`80`/`90`/`100`/`110`/`120`/`130`); aliases like `85`/`95` are NOT matchable (parse error). 25 mph=`40` is intentionally excluded. |
| **Ships via** | Railway redeploy of the brouter service(s). |
| **Verified** | Local A/B on stock brouter.de tiles via BRouter's own `WayTags` export (ground truth). Comfort fixed at tiny cost: your NE 74th→St Johns **272 m → 0 m (+1%)**, St Johns→Gateway **616→0 (+1%)**, outer-SE **1791→0 (+2%)**, Belmont→Mt Tabor **43→0 (free)**. Cully→PDX **yields** (1316 m unchanged, 0% — airport road, no calm alt). No failed routes, no blow-ups; ultra essentially unchanged (already avoided these). |
| **Unwind** | Remove the `hasphysicalbikelane`/`fastnolane` assigns **and** the `add fastnolane` line from all four `.brf` files, then redeploy. |
| **Tune** | The `2`/`3`/`5` penalty strengths (raise to avoid harder / detour more; lower to yield sooner) and the maxspeed token set. |

### A6 — Door-zone lanes: knock down plain unbuffered lanes on classified streets
A `weaklane` penalty (routing) + an arterial-lane bake (color) for the **NE 7th
Ave** case: a **plain painted bike lane (`cycleway=lane`, NOT a protected `track`)
with NO buffer, running along a classified through-street (tertiary/secondary/
primary)**. These are Portland's door-zone collector lanes. A1–A5 all miss them:
7th is posted **20 mph** in OSM and **has** a lane, so no speed/no-lane/stroad rule
fires; today it routes cheap (tertiary+isbike=1.0) and `ultra` even gave it the
`strongbikelane` greenway-magnet credit. So this keys off **road class + plain-lane
+ unbuffered**, not speed.

**The buffer split is the crux.** `cycleway:*:buffer` is **NOT in stock BRouter
`lookups.dat`** (prod's brouter.de tiles can't see it). So the routing change is
**self-build ONLY** and required adding the tag to `lookups.dat` + a tile rebuild.
**This intentionally DIVERGES the two profile sets** — `brouter-service/profiles/`
(prod) is now NOT identical to `brouter-service-selfbuild/profiles/`; only the
self-build copies carry `weaklane`. The "profiles are byte-identical" assumption
from A2–A5 no longer holds. Coloring has no such limit (PBOT distinguishes BL vs
BBL), so the **map color** down-rate applies on both engines / web + iOS.

| | |
|---|---|
| **Routing (self-build only)** | `brouter-service-selfbuild/profiles/{safety-comfort,safety-ultra}.brf`: `isweaklane` + `weaklanepenalty` (comfort **+0.4**, ultra **+1.0**) + `add weaklanepenalty`; ultra also gates the `strongbikelane` magnet on `not isweaklane`. |
| **Tiles (self-build only)** | `data/brouter-build/tools/brouter/brouter-1.7.9/profiles2/lookups.dat` + committed copy `brouter-service-selfbuild/profiles/lookups.dat` add `cycleway:{both,left,right}:buffer`; `brouter-service-selfbuild/Dockerfile` COPYs it so **build & serve lookups match** (a mismatch silently misdecodes tags); `brouter-service-selfbuild/segments4/*.rd5` rebuilt via `scripts/build-brouter-tiles.sh`. |
| **Color (both engines, web+iOS)** | `scripts/lib/render-class.ts` (`buildArterialGrid` + arterial-lane→`busy`, class `lane` only — buffered/protected spared), callers `scripts/{bake-render-class,export-bike-network}.ts` pass `arterials.geojson`. Re-baked all 3 `bike-network.geojson`. **No `friendliness.ts`/Swift change** — both already read `rclass`, so the bake covers overlay + route on both surfaces (parity guard stays green). |
| **Ships via** | Railway redeploy of **`brouter-selfbuild` only** (prod unchanged) + Web (Vercel) + iOS. |
| **Verified** | Color: NE 7th tertiary core 63 `lane`→busy, its greenway/buffered/protected segments spared; SE 17th 15 `buffered` preserved; Rodney/Ankeny/Klickitat greenways untouched (1602 `lane`→busy metro-wide — Portland stripes most painted lanes on arterials). Routing (post-rebuild, local BRouter on the self-build tiles): `cycleway:*:buffer` decodes via WayTags (`:buffer=no` on NE 7th, `:buffer=yes` on SE 17th) — no lookups/tile mismatch; weaklane-vs-control A/B fires **only** unbuffered (NE 7th +0.4; SE 17th's 5 buffered segs unchanged — spared); home→inner-SE door-zone metres prod 486 → comfort 53 / **ultra 0** (parallel greenway, no distance cost). Full A/B in `docs/SPEED_ROUTING.md`. |
| **Unwind** | Routing: drop the `isweaklane`/`weaklanepenalty` assigns + `add weaklanepenalty` from the two self-build `.brf`s, revert the ultra magnet line, redeploy selfbuild. (Profiles re-converge with prod.) Color: revert `render-class.ts` + the two callers, `npm run bake:render-class`. Tiles can keep the buffer lookup harmlessly. |
| **Tune** | `weaklanepenalty` strengths (comfort 0.4 / ultra 1.0) and `ARTERIAL_DOWNRATE_CLASS`/arterial class set. |

**Cull all of A:** revert the A1+A2+A3+A4+A5+A6 file lists above, then redeploy whatever
routers/web/iOS had already shipped.

---

## B. Pre-existing uncommitted work (NOT this session)

~1,000 lines that were already dirty in the tree before this session — a separate
effort. Catalogued so it can be committed, stashed, or culled. **Blanket unwind:**
`git stash` (everything) or `git checkout -- <files>` per cluster.

### B1 — Prod ↔ self-build engine toggle (routing A/B)
Lets the app pick the `prod` vs `selfbuild` BRouter. _This is what makes
`engine:"selfbuild"` work — the test-router validation above relies on it._

`server/src/config.ts` (`brouterUrlSelfbuild`), `server/src/routes/route.ts`
(`engine` param), iOS `RouteStore.swift` (engine select + persistence),
`ControlsBar.swift` (toggle UI).

### B2 — "Build" tap-to-add waypoint mode + tap-built connectors
Guided draw: tap to append pass-through waypoints; tap-built connector fixes.

`web/src/App.tsx` (`buildMode`), `web/src/components/RouteDrawer.tsx`
(`EditTool "build"`, undo/clear waypoint), `web/src/styles.css`, `Help.tsx`,
iOS `MapCoordinator.swift` (freehand sketch + connector tap-build),
`RootView.swift` (connector confirm), `ControlsBar.swift`, `GestureGuideView.swift`,
`ConnectorsView.swift`, `GeoJSON.swift`, `MatchService.swift`.

### B3 — PBOT-aware corridor / coverage steering
`server/src/services/greenway-coverage.ts` (+158: facility coverage + corridor finder).

---

## C. Deploy state (live as of writing)

| Target | Carries | Status |
|---|---|---|
| Prod router `brouter` (app's `prod`) | A2 + A3 + A4 + **A5** | ✅ A4 deployed 2026-06-24 · A5 deployed 2026-06-26 |
| Self-build router `brouter-selfbuild` (app's `selfbuild`) | A2 + A3 + A4 + A5 + **A6** | ✅ A4 deployed 2026-06-24 · A5 deployed 2026-06-26 · **A6 (weaklane + rebuilt buffer tiles) deployed 2026-06-26** — verified live: home→inner-SE door-zone 486 m (prod) → 53 m comfort / 0 m ultra · **DEFAULT engine for web + iOS as of 2026-06-30** (toggle moved into each app's Settings menu; server still defaults a missing `engine` to `prod`) |
| Web (Vercel) | A1 (+ would also ship B1/B2) | ⛔ blocked on mixed tree |
| iOS (TestFlight) | A1 (+ would also ship B1/B2/B3) | ⛔ blocked on mixed tree |
| Orphan `brouter-selfbuild` service | stray deploy + a public domain I created | 🧹 to remove |

## D. Entanglement warning
A1's web changes share the `web/` tree with B1/B2; a Vercel build ships the whole
tree. To deploy A1 (colors) without B1/B2, the tree must be separated first
(commit/stash B, or branch A). The routers (A2/A3) are isolated and safe to ship
independently.
