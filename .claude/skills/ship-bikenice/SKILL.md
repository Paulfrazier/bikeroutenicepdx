---
name: ship-bikenice
version: 1.0.0
description: |
  Ship/update workflow for BikeRouteNicePDX across all surfaces (web, iOS, server, shared data). Regenerates shared data, runs the static guards, builds + deploys web, ports/verifies iOS, and updates memory. Use when asked to "ship bikenice", "update bike nice", "release bikenice", or after changing a feature that touches more than one surface.
allowed-tools:
  - Bash
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - AskUserQuestion
---

# Ship / update BikeRouteNicePDX

This project spans four surfaces that drift apart silently: **web** (React/Vite → Vercel), **iOS** (SwiftUI, on-device), **server** (Hono → Railway), and **routing services** (BRouter + Valhalla on Railway). The job of this skill is to make a cross-surface change land consistently. It does **not** re-implement the checks — it runs `npm run check` and the export scripts, which are the single source of truth.

Run from the repo root: `/Users/pfrazier/Documents/claude/BikeRouteNicePDX`.

## 0. Scope the change
Look at the diff (`git status`, `git diff`) and classify what was touched:
- **Shared data source** (PBOT/OSM, any `scripts/export-*.ts` or `scripts/fetch-*.ts` logic) → step 1.
- **Friendliness classifier** (`web/src/friendliness.ts` and/or `ios/.../Services/BikeFriendliness.swift`) → these are a **paired surface**; a change to one almost always needs the other. The guard in step 2 enforces it.
- **Server routing/API** (`server/src/**`) → web and iOS both consume it; check the API contract in the project memory note before changing response shapes.
- **Web-only or iOS-only UI** → still run step 2; skip the export.

## 1. Regenerate shared data (only if a data source or export script changed)
Each export writes the SAME GeoJSON to every target at once. Run the one(s) that apply — never hand-edit a single copy:
```bash
npm run export:bike-network   # → web/public · ios/.../Resources · server/data
npm run export:greenways      # → web/public · ios/.../Resources
npm run export:arterials      # → web/public · ios/.../Resources
```
These hit live PortlandMaps/Overpass APIs, so they refresh data — expect web + iOS + server bundles to all change, which means all three need redeploy/rebuild below.

## 2. Run the static guards — MUST pass before shipping
```bash
npm run check
```
This runs: server typecheck · web typecheck · **parity guard** (`check-parity.ts`: web↔iOS friendliness constants + class→tier mapping) · **data-sync guard** (`check-data-sync.ts`: the 3-target GeoJSON copies are byte-identical).

- **Parity fail** → you changed a constant or tier mapping in one of `friendliness.ts` / `BikeFriendliness.swift` but not the other. Make them match.
- **Data-sync fail** → a GeoJSON target is missing or diverged. Re-run the named `export:*` script (step 1). Do **not** patch a single copy by hand.

Do not proceed while `check` is red. CI (`.github/workflows/ci.yml`) runs the same command and will block otherwise.

## 3. Optional deeper gate (only when routing logic changed)
The route-quality suite needs the local stack and isn't in CI:
```bash
cd routing && docker compose up -d        # local Valhalla :8002 (for /match)
cd ../server && npm run dev                # :3000   (separate shell)
npm run test:routes                        # from repo root, once /health is up
```
8 canonical Portland trips assert greenway coverage + forbidden-street avoidance. See `tests/routes/README.md`.

## 4. Build + deploy web
```bash
npm --workspace web run build
```
Then commit + push. Web (Vercel) and server (Railway) are **git-linked → auto-deploy on push to `main`**. Verify after: `bikeroutenicepdx.vercel.app` (use the alias, not the hashed URL) and the Railway `/health`. CORS: the server allowlists the Vercel origin via `WEB_ORIGIN`.

## 5. Port + verify iOS (if any shared surface or iOS file changed)
iOS is **not** auto-deployed — it's a manual device build. If step 1 regenerated GeoJSON, or you touched `BikeFriendliness.swift` or any `ios/**` file:
```bash
cd ios && xcodegen generate
xcodebuild -project BikeRouteNicePDX.xcodeproj -scheme BikeRouteNicePDX \
  -destination 'generic/platform=iOS' \
  DEVELOPMENT_TEAM=DFG7YZ82LP -allowProvisioningUpdates build
# then: devicectl device install app …   (see reference_ios_devicectl_install)
```
iOS points at the Railway server, so a server change is picked up live; a **data or classifier** change requires this rebuild to reach the device.

## 6. Update memory + commit hygiene
- Update the BikeRouteNicePDX memory notes (`project_bikeroutenicepdx.md` / `project_bikeroutenicepdx_ios.md`) with what shipped.
- Commit only the files for this change (a parallel session may have unrelated work in the tree — stage by explicit path, don't `git add -A`).

## Quick reference — paired surfaces that must move together
| Change | Also update |
|---|---|
| `web/src/friendliness.ts` | `ios/.../Services/BikeFriendliness.swift` (constants + tier map) |
| any `*.geojson` | re-run the `export:*` script (rewrites all 3 targets), then rebuild iOS |
| `server` API response shape | web + iOS decoders (Swift decodes strictly) |
| `routing/costing-overrides.json` | `routing/conf/graph.lua` (cost factors duplicated) |
