# Build Log

Newest entries first. Each entry: the prompt that drove the work, the problem,
the solution, key decisions, and the files that changed.

---

## 2026-09-23/24 — Speed + usability pass (web and iOS); iOS build 8

**Prompt:** "Look at my apps starting with bikenice, then plan shop eat, and refactor if it makes
sense, now that 5.5 is smarter and more efficent." → mid-task: "want speed, usability, and nice to
use design improvements" → "deploy and is it on my phone" → "ios apps?" → "yes. thats what I want!
ios as well" → "do it" (TestFlight).

**Approach:** Measure first (bundle size, live cache headers, headless Playwright + swiftshader
screenshots at 390px, direct API timing, a Swift bench of the GeoJSON loader), then fix what
riders feel. Code-structure refactors (splitting `Map.tsx`, a single edit-mode enum in `App.tsx`)
were considered and deliberately deferred — no user-visible change.

### Web (`f35122f`, deployed via `vercel --prod`)
- **Route latency −0.4–0.9 s.** `useRoute` waited a 400 ms "typing" debounce on endpoint changes,
  but `from`/`to` only change on discrete commits (search pick, map tap, pin drop, swap). Now 0 ms.
  Measured end-to-end 3.4–3.9 s → 2.9–3.0 s; the server itself is ~1.0 s.
- **Caching.** Hashed `/assets/*` were served `max-age=0, must-revalidate`; now
  `max-age=31536000, immutable` (`web/vercel.json`). MapLibre split into its own chunk
  (`vite.config.ts` `manualChunks`) so it survives app deploys in the browser cache.
- **Units.** Route summary + directions showed km while turn-by-turn and iOS use miles; all mi/ft
  now (`fmtDistanceImperial`).
- **Mobile panel.** ↕ swap button floats in a zero-height row between From/To instead of costing
  a row; preference dial got the 16px gutter; tighter header. Saved places ★ → ♥ (street ratings
  keep ★). MapLibre compact attribution starts collapsed (it ran under the legend). Brand copy
  "PDX Greenways" → "BikeRoute PDX".

### iOS (`9bb6b2e`, TestFlight build 8, installed on iPhone via devicectl)
- **Launch freeze removed.** `MapView.makeUIView` parsed the 8.7 MB `bike-network.geojson` on the
  main thread 4× (two loaders × JSONSerialization sanitize + MKGeoJSONDecoder) plus a JSON parse
  of every feature's properties — ~650 ms on an M-series Mac. Now `BikeNetworkLoader.parse()`
  does one pass on a detached task into Sendable coordinate arrays; overlays are built on the main
  actor and **inserted at the bottom of `.aboveRoads`** so connector fixes still paint on top.
  `SupplementNetworkLoader` folded in (file keeps only the `SupplementLine`/`SupplementInfo` types).
- **First route faster.** `BikeFriendliness.warmUp()` builds its indexes right after the map loads.
- **Zoom-scaled network widths** (1.0 → 0.5 from span 0.04° → 0.16°, 0.1 steps, repainted in
  `regionDidChangeAnimated`) so the metro view isn't a solid mat of color.
- **Legend** starts below the toolbar row (top padding 56) instead of covering Fixes/Settings.

**Verification:** `npm run check` green; local build vs live via Playwright; iOS simulator
screenshots (network renders, toolbar clear); live headers confirmed `immutable` post-deploy.
