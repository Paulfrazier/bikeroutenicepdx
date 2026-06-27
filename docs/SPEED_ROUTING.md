# Speed-aware coloring & routing

How BikeRouteNicePDX treats **fast streets with bike lanes** (e.g. MLK, Lombard) —
across the map overlay, the route line, and the BRouter routing engine — plus a
measured before/after routing report and the knobs to tune it.

_Last measured: 2026-06-24._

---

## 1. The problem

PBOT paints a bike lane and the old system colored it by facility type only — a
buffered lane on a 45 mph stroad looked the same teal as one on a 20 mph street,
and the router treated it as nearly ideal. Two fixes, kept in lock-step:

1. **Color** an unprotected lane on a fast street **red** on both the static
   overlay and the route line.
2. **Route** around fast streets via a BRouter cost penalty.

"Unprotected" = `buffered` / `lane` / `shared`. Physically separated facilities
(`protected` / `greenway` / `path`) are **never** down-rated — a protected lane on
a fast road is still protected.

---

## 2. Coloring (map overlay + route)

### Rule
An unprotected lane whose street is posted **≥ 40 mph** (PBOT speed data) is baked
down to render class `busy` (red, dashed). Everything else keeps its facility
color. The downgrade is **baked into the data** (`rclass` property on every
bike-network feature), so the overlay and the route read the same value and can
never disagree — Lombard reads red on the map before you route on it.

| Posted speed | Unprotected lane (buffered/lane/shared) | Separated (protected/greenway/path) |
|---|---|---|
| ≤ 35 mph | facility color (teal / amber / gray) | own color |
| **≥ 40 mph** | **red (`busy`)** | own color |

### Where it's computed
- `scripts/lib/render-class.ts` — the join (speeds ≥ `MIN_FAST_MPH` → `rclass`).
- Baked by `scripts/export-bike-network.ts` (and re-bakable offline via
  `npm run bake:render-class`) into all three `bike-network.geojson` copies.
- Consumed by `web/src/friendliness.ts` + `web/src/components/Map.tsx` (web) and
  `BikeFriendliness.swift` + `BikeNetworkLoader.swift` + `MKPolyline+Kind.swift`
  (iOS). Web↔iOS kept in sync by `scripts/check-parity.ts`.

### Result on the streets you named
196 of 6,139 features downgraded. Speed is from PBOT data (precise):

| Street | Facility | PBOT speed | Now colored |
|---|---|---|---|
| SE 17th | buffered | 30 | **teal** (unchanged — not fast) |
| NE MLK | plain lane | 55 | **red** |
| NE Lombard | plain lane | 35 / 45 | **red** on the 45 part, amber on 35 |
| N Lombard | buffered/lane | mostly 30–35, some 40–45 | red only on the 40+ segments |
| SE Powell (US26) | buffered/lane | **30** in PBOT data | unchanged (see §5) |

---

## 3. Routing penalty (BRouter `safety-ultra`)

The stock cost model keys off highway **class**, not speed, and leaves bike-laned
arterials cheap (`tertiary + bike lane = 1.0`). A `speedpenalty` now adds cost by
posted speed, applied **regardless of bike infrastructure**:

| Posted speed | Penalty added to cost factor |
|---|--:|
| ≤ 40 mph | 0 |
| 45 mph | **+0.4** |
| 50 / 55+ mph | **+0.7** |

### Why the line is at 45, not 40
BRouter quantizes OSM `maxspeed` into buckets, and **35 mph and 40 mph share one
bucket** (45/50/55 are each separate). Penalizing 40 would also penalize every
35 mph street and trash normal routing, so routing acts only at **45+**. The map
still reds 40 mph lanes from precise PBOT data. This is the **one intentional
mismatch**: a true-40 mph lane is red on the map but not routing-avoided (see §5).

`brouter-service/profiles/safety-ultra.brf`, `assign speedpenalty`.

### Companion: 4-lane stroad penalty (lanes, not speed)

The speed penalty deliberately ignores 35–40 mph streets — but a **4-lane road
with no bike lane** at 35–40 mph (Holgate, parts of Powell/82nd/Sandy) is exactly
the hazard this router exists to avoid, and it slips under the 45 mph line. A
separate `stroadpenalty` closes that gap, keying off **lane count** instead of
speed: any way with `lanes>=4` and **no real bike lane** gets a large additive
penalty (**+50**, "effectively no-go"). A painted/protected lane or a designated
bike street redeems it; sharrows and bare `bicycle=yes` do not. It applies to
**both** safety tiers (Ultra + Comfort).

The two penalties are **complementary**: speed catches fast *bike-laned*
arterials; lanes catches slower *un-laned* 4-laners. Crossing a stroad
perpendicularly is unaffected (`costfactor` is per-way — it only fires when riding
*along* the road). `lanes` is in BRouter's stock `lookups.dat`, so this needs no
tile rebuild and works on the brouter.de (prod) tiles. See `assign stroadpenalty`
in both profiles and **A4** in `docs/CHANGE_INVENTORY.md`.

### Companion: fast-no-physical-lane penalty (the 2–3 lane gap)

The speed penalty starts at 45 mph and the stroad penalty needs 4+ lanes — so a
**2–3 lane 30–40 mph collector with no painted lane** falls through both. Worse,
some such streets (e.g. **NE Halsey** around NE 70th) are tagged
`bicycle=designated` with **no physical lane**, which made the stroad penalty's
`hasrealbikelane` treat them as safe and exempt them entirely. Comfort happily
rode them; Ultra only dodged them as a side effect of its globally higher arterial
aversion.

`fastnolane` closes this: a graduated additive penalty (**30 mph +2, 35–45 mph +3,
50+ mph +5**) on any way posted **above 25 mph** with **no PHYSICAL bike lane** —
a new `hasphysicalbikelane` that, unlike `hasrealbikelane`, does **not** count
`bicycle=designated`. The values are deliberately gentle: enough to divert onto a
parallel calm street when one exists (NE 74th→St Johns drops 272 m of no-lane
Halsey for a +1% detour), but small enough to **yield** where there's no calm
alternative (the 38 mph airport approach on Cully→PDX rides through rather than
detouring 4.7 km). `maxspeed`/`cycleway` are in stock `lookups.dat` — no tile
rebuild — but `maxspeed` must match a **canonical** bucket token (30 mph=`50`,
35-40=`60`, 45=`70`, 50–80 mph=`80`/`90`/`100`/`110`/`120`/`130`); aliases like
`85`/`95` are not matchable. See `assign fastnolane` in both profiles and **A5**
in `docs/CHANGE_INVENTORY.md`.

### Companion: door-zone weaklane penalty (the lane-on-a-busy-street gap) — self-build only

All of the above key off speed or absence-of-lane. The remaining gap is a street
that **has** a lane and is posted **slow** but is still low-comfort: a **plain,
unbuffered, door-zone painted lane on a busy through-street**. The motivating case
is **NE 7th Ave** through inner NE — in OSM it's `highway=tertiary`,
`cycleway=lane`, `cycleway:*:buffer=no`, **`maxspeed=20 mph`**. Because it's posted
20 and carries a lane, *none* of the speed/no-lane/stroad rules touch it; it routes
cheap (`tertiary`+`isbike`=1.0) and Ultra even handed it the `strongbikelane`
greenway-magnet credit. So the lever here is **road class + plain-lane + unbuffered**,
not speed.

`weaklane` fires on a way that is (a) `highway=tertiary|secondary|primary` (+links),
(b) a plain `cycleway=lane` and **not** a protected `track`, and (c) **not buffered**
(`cycleway:*:buffer=yes`). Additive penalty: **comfort +0.4, ultra +1.0**; Ultra
*also* denies it the `strongbikelane` magnet so a parallel neighborhood greenway
(e.g. the Rodney / NE 9th greenway) wins. Gentle enough that an unavoidable block
still resolves.

**Why self-build only:** `cycleway:*:buffer` is **not in stock BRouter
`lookups.dat`**, so prod's brouter.de tiles can't tell a buffered lane from a
door-zone one. The buffer tag was added to `lookups.dat` and the **self-build tiles
rebuilt** so only *unbuffered* lanes are penalized — so this lives **only** in the
`brouter-service-selfbuild/profiles/` copies and the two profile sets now diverge
(prod is unchanged). See `assign weaklane`/`isweaklane` and **A6** in
`docs/CHANGE_INVENTORY.md`.

**Verified (post-rebuild, local BRouter on the self-build tiles).** BRouter's own
WayTags export is ground truth that `cycleway:*:buffer` **decodes** (no
lookups/tile mismatch): NE 7th's tertiary segments report
`cycleway:right:buffer=no`, SE 17th reports `…:buffer=yes`. A weaklane-vs-control
A/B *on the same tiles* fires the penalty **only** on the unbuffered case — NE 7th
core cost 2960 → 2989 (the +0.4 applied), SE 17th's 5 buffered segments **unchanged**
(3494 → 3494, spared) — which rules out the "buffer misdecodes → every plain lane
penalized" failure mode. End-to-end (home → inner-SE waterfront), metres ridden on a
plain unbuffered classified lane: **prod 486 m** (comfort *and* ultra — stock tiles
can't see the buffer) vs self-build **comfort 53 m** (+199 m, +3 %) and **ultra 0 m**
(detours to the parallel Rodney/9th greenway at 7031 m ≈ prod ultra's 7033 m — no
distance cost).

---

## 4. Before/after routing report

Measured on a local BRouter (Portland segment, same engine as prod). 14 OD pairs,
each deliberately spanning a ≥45 mph corridor (endpoints 600 m beyond each end so a
detour is possible). `fast45` = metres of the route on ≥45 mph streets.

| Corridor (≥45 mph) | before — dist / fast45 | mild (live) — dist / fast45 | strong — dist / fast45 |
|---|--:|--:|--:|
| N Greeley Ave (45) | 3649 / 1268 | 3668 / 1216 | 3668 / 1216 |
| N Marine Dr (45) | 2336 / 1681 | 2336 / 1681 | 2407 / 1620 |
| Hwy 30 (45) | 2466 / 1655 | 2466 / 1655 | 2466 / 1655 |
| N MLK (55) | 3934 / 2123 | 3934 / 2123 | 3095 / **0** |
| S Macadam Ave (45) | 2914 / 1171 | 2914 / 1171 | 2914 / 1171 |
| NE 82nd Ave (45) | 2775 / 1686 | 2775 / 1686 | 4188 / 106 |
| NE Airport Way (45) | 2575 / 2554 | 2575 / 2554 | 3024 / 1589 |
| S Terwilliger Blvd (45) | 2369 / 226 | 2369 / 226 | 2369 / 226 |
| NW Cornell Rd (45) | 2554 / 889 | 2554 / 889 | 2554 / 889 |
| N Lombard St (45) | 1707 / 1239 | 1707 / 1239 | 1707 / 1239 |
| NW Miller Rd (45) | 4828 / 915 | 4828 / 915 | 4828 / 915 |
| NE Killingsworth St (45) | 2445 / 1494 | 2445 / 1494 | 2469 / 1356 |
| SW Barbur Blvd (45) | 4564 / 1772 | 3055 / **0** | 3055 / **0** |
| NE Portland Hwy (45) | 1562 / 1548 | 1562 / 1548 | 1562 / 1548 |

- **mild** = the deployed curve (+0.4 / +0.7). **strong** = +2.0 / +5.0 (a tuning probe).
- **Mild changed 2/14** corridors; **strong changed 7/14**.
- ≥45 mph exposure totals: **before 20,221 m → mild 18,397 m → strong 13,530 m** (strong −33%).

### Interpretation
1. **`safety-ultra` already avoids fast streets** wherever a reasonable calm
   alternative exists — most ordinary trips have **0 m** of fast-street exposure
   before any penalty. The penalty is a tie-breaker / guarantee, not the main lever.
2. **The mild (live) penalty barely reroutes** — it flips clear cases (Barbur: a
   shorter non-arterial path was available and the penalty tipped it) but mostly
   just makes fast streets cost more without changing the choice.
3. **~Half these corridors never change at any strength** (Hwy 30, Macadam,
   Terwilliger, Cornell, Lombard, Miller, Portland Hwy) — they're the *only*
   bike-accessible route across a barrier (bluff, river, freeway). No penalty
   should reroute those, and none does.
4. **Strong reroutes more (−33%)** but at a real cost: NE 82nd detours +51%
   (2775 → 4188 m) to shed a fast stretch. That's the "trashing routing" risk.

---

## 5. Color ↔ routing alignment

| Posted speed | Map color | Routing penalty | Aligned? |
|---|---|---|---|
| ≤ 35 mph | facility color | none | ✓ |
| 40 mph | **red** | none (bucket-merged with 35) | ✗ — red but routable |
| 45 mph | red | +0.4 | ✓ |
| 50 / 55+ | red | +0.7 | ✓ |

The single gap is **40 mph**: colored red (PBOT data is precise) but not
routing-penalized (BRouter can't split 40 from 35). Also note the two surfaces use
**different speed sources** — colors use PBOT `speeds.geojson`, routing uses OSM
`maxspeed` — so a street mistagged in one source can disagree with the other.

---

## 6. Knobs (how to tweak)

| Want | Change | Where |
|---|---|---|
| Color more/less aggressively | `MIN_FAST_MPH` (40) → 35 or 45, then `npm run bake:render-class` | `scripts/lib/render-class.ts` |
| Stronger routing avoidance | bump `speedpenalty` values (e.g. 45 → +1.0, 50/55 → +2.5) | `brouter-service/profiles/safety-ultra.brf` |
| Penalize 40 mph in routing too | add the shared 35–40 bucket `switch maxspeed=60\|65 …` — **warning: also hits every 35 mph street** | same |
| Penalize buffered less than plain | re-introduce a facility check in `bakeRenderClass` | `scripts/lib/render-class.ts` |

Measured trade-off for the routing strength knob: **mild ≈ no rerouting**,
**strong (+2/+5) ≈ −33% fast-street exposure but +50% detours on no-alternative
trips.** A middle value (e.g. +1.0 / +2.0) is untested but likely the sweet spot if
you want visible avoidance without the worst detours.

---

## 7. Deploy

- **Web** (colors + route): Vercel — ships `web/`.
- **iOS** (colors + route): rebuild + TestFlight.
- **Routing penalty**: redeploy the **brouter service** to Railway (it bundles
  `brouter-service/profiles/safety-ultra.brf`). This is a **separate deploy** from
  the web app; the color changes work without it, but routing won't avoid fast
  streets until it ships.
