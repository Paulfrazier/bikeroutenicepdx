# BikeRouteNicePDX — repo conventions

## Engine bake-off — committed but inert

The per-request engine bake-off (race Valhalla + BRouter + ORS + GraphHopper,
pick the best-coverage route) is a **deliberately OFFLINE experiment**. It now
lives committed-but-inert under `server/src/experiments/engine-bakeoff/` (with a
README), so it's preserved and typechecked but imported by nothing in the live
request path. The runner stays at `scripts/compare-engines.ts`
(`npm run compare:engines`).

The **one rule that remains**: do NOT re-wire `server/src/routes/route.ts` to
`bakeoffRoute` — prod `/route` must call `getRouteBrouter` (BRouter-only). The
prod guarantee is now enforced by structure (nothing in the request path imports
the experiment), not by remembering never to commit.

`git add -A` is fine again — the tree is clean and `.gitignore` covers the heavy
regenerable data/build artifacts recursively. The only staging caveat is the
generic one: if a parallel session has unrelated work in the tree, stage your own
change by explicit path. Run `npm run clean` (or `clean -- --all`) to drop
regenerable artifacts (iOS builds, dist, fetched data, tiles).

## Shipping

`/route` and `/match` already return `duration_s` (BRouter `total-time` /
Valhalla trip time); web + iOS both display it as a time estimate. Use the
`ship-bikenice` skill for multi-surface releases.
