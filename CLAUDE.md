# BikeRouteNicePDX — repo conventions

## ⛔ DO NOT COMMIT the engine bake-off

The per-request engine bake-off (race Valhalla + BRouter + ORS + GraphHopper,
pick the best-coverage route) is a **deliberately OFFLINE side project**. Prod
`/route` stays **BRouter-only**. These working-tree changes must **never** be
committed or deployed — leave them dirty in the tree:

- `server/src/services/bakeoff.ts` — the bake-off itself
- `server/src/services/ors.ts` — ORS engine (bake-off only)
- `server/src/config.ts` — ORS/HeiGIT URL (only used by the bake-off)
- `scripts/compare-engines.ts` — `npm run compare:engines` offline harness
- `docs/ENGINE_BAKEOFF.md` — bake-off write-up (untracked)
- **Do NOT** re-wire `server/src/routes/route.ts` back to `bakeoffRoute` — prod
  must call `getRouteBrouter`.

When committing, stage **explicit paths** — never `git add -A` / `git add .`,
which would sweep the bake-off in. (See also the "big untracked data" gotcha:
`du -sh` before any broad add.)

Entangled but NOT bake-off (these are legit prod improvements — commit on their
own when ready, separately from the bake-off): `server/src/services/brouter.ts`
(named turn-by-turn steps + inline greenway coverage on the BRouter path).

## Shipping

`/route` and `/match` already return `duration_s` (BRouter `total-time` /
Valhalla trip time); web + iOS both display it as a time estimate. Use the
`ship-bikenice` skill for multi-surface releases, but review `git status` first
and stage paths explicitly per the rule above.
