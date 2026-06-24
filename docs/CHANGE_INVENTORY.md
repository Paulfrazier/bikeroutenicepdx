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

**Cull all of A:** revert the A1+A2+A3 file lists above, then redeploy whatever
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
| Test router `beautiful-charm` (app's `selfbuild`) | A2 + A3 | 🔄 deploying |
| Prod router `brouter` (app's `prod`) | A2 + A3 | ⛔ not deployed |
| Web (Vercel) | A1 (+ would also ship B1/B2) | ⛔ blocked on mixed tree |
| iOS (TestFlight) | A1 (+ would also ship B1/B2/B3) | ⛔ blocked on mixed tree |
| Orphan `brouter-selfbuild` service | stray deploy + a public domain I created | 🧹 to remove |

## D. Entanglement warning
A1's web changes share the `web/` tree with B1/B2; a Vercel build ships the whole
tree. To deploy A1 (colors) without B1/B2, the tree must be separated first
(commit/stash B, or branch A). The routers (A2/A3) are isolated and safe to ship
independently.
