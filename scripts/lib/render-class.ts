/**
 * render-class.ts — bake a per-feature `rclass` (render class) onto the bike
 * network by joining it against PBOT posted speeds.
 *
 * WHY: the map overlay and the route line are both colored by a feature's class.
 * An UNPROTECTED on-street lane (buffered/lane/shared) that runs along a FAST
 * street (posted ≥ MIN_FAST_MPH) is stressful regardless of the paint, so we
 * down-rate it to "busy" (red) — the SAME signal the route classifier applies —
 * so the static overlay and the route never disagree, and Lombard/MLK read red
 * on the map before you even route on them. A milder context — a painted lane on
 * a slower arterial — down-rates only to "caution2/3/4" (an orange gradient that
 * darkens with the arterial's lane count): still a lane, just a stressful street,
 * distinct from the red danger signal (see bakeRenderClass). Physically separated
 * facilities (protected / greenway / path) are NEVER down-rated.
 *
 * The downgrade keys off POSTED SPEED only (not the bicycle high-crash layer) so
 * it lines up with the BRouter `safety-ultra` maxspeed penalty, which can only
 * see OSM `maxspeed`. Threshold is shared by both surfaces (see MIN_FAST_MPH).
 *
 * MULTI-LANE STROADS: posted speed alone misses the 30–35 mph 4–5 lane arterials
 * (SE Foster, SE Powell, SE Holgate, N Lombard) — a buffered/painted lane stranded
 * on a wide stroad is stressful even at 30 mph, but sits below MIN_FAST_MPH. So we
 * ALSO down-rate any unprotected facility on a street tagged OSM `lanes` ≥
 * MIN_STROAD_LANES. A calm 2–3 lane buffered lane (SE 17th, N Williams) is spared,
 * which is what keeps "buffered" ranked above a no-facility calm collector.
 *
 * Used by export-bike-network.ts (bakes rclass into the canonical export) and by
 * the standalone re-bake CLI (scripts/bake-render-class.ts).
 */

export type FeatureLike = {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
};

export type FCLike = { features?: FeatureLike[] };

/** Posted speed (mph) at/above which an unprotected lane is down-rated to red.
 * Mirrors the BRouter safety-ultra speed penalty (which starts above 35 mph). */
export const MIN_FAST_MPH = 40;

/** OSM `lanes` count (total, both directions incl. turn lanes) at/above which a
 * street counts as a multi-lane stroad: an unprotected facility along it is
 * down-rated to "busy" even when posted below MIN_FAST_MPH. Catches the 30–35 mph
 * 4–5 lane arterials (Foster, Powell, Holgate, Lombard) the speed rule misses;
 * spares calm 2–3 lane buffered lanes (SE 17th, N Williams) so "buffered" keeps
 * its rank above a no-facility calm collector. */
export const MIN_STROAD_LANES = 4;

/** Facility classes that are physically separated/calmed — never down-rated.
 * `calm`/`calm_mod` (PBOT SR_LT/SR_MT shared roadways) are quiet-by-definition
 * recommended streets with no facility to "strand" on a stroad, so the speed/
 * arterial down-rate doesn't apply — they keep their class as rclass. */
const STRONG = new Set(["protected", "greenway", "path", "calm", "calm_mod"]);

/** The one weak facility we down-rate when it runs ALONG an arterial: a plain
 * unbuffered painted lane (PBOT "BL"). A buffered lane ("buffered"/BBL) is a
 * comfortable facility and is spared; sharrows ("shared") are handled elsewhere.
 * Mirrors the BRouter self-build `weaklane` penalty (cycleway=lane + unbuffered
 * on a classified through-street). See docs/ROUTING_COLOR_LOGIC.md. */
const ARTERIAL_DOWNRATE_CLASS = "lane";

// Spatial-join tolerances — mirror the friendliness "on/along a street" test
// (ARTERIAL_THRESHOLD_M / ARTERIAL_BEARING_TOL_DEG) so the bake matches runtime.
const CELL = 0.0003; // ~33 m grid
const THRESHOLD_M = 18;
const BEARING_TOL_DEG = 30;
const DEG2RAD = Math.PI / 180;
const M_PER_DEG_LNG = 111320;
const M_PER_DEG_LAT = 110540;

type LngLat = [number, number];
interface Seg {
  a: LngLat;
  b: LngLat;
  bearing: number;
  /** OSM `lanes` count for the source way (0 when untagged). Only populated for
   * the arterial-lane grid; the fast-speed grid leaves it 0. */
  lanes: number;
}
export type FastGrid = Map<string, Seg[]>;

function bearing(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const dLng = (b[0] - a[0]) * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

function bearingDiff(b1: number, b2: number): number {
  let d = Math.abs(b1 - b2) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

function perpDistanceM(M: LngLat, a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(M[1] * DEG2RAD);
  const toXY = (p: LngLat): [number, number] => [
    (p[0] - M[0]) * cosLat * M_PER_DEG_LNG,
    (p[1] - M[1]) * M_PER_DEG_LAT,
  ];
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(ax, ay);
  let t = (-ax * dx - ay * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function addSeg(grid: FastGrid, a: LngLat, b: LngLat, lanes = 0): void {
  const seg: Seg = { a, b, bearing: bearing(a, b), lanes };
  const lat0 = Math.floor(Math.min(a[1], b[1]) / CELL);
  const lat1 = Math.floor(Math.max(a[1], b[1]) / CELL);
  const lng0 = Math.floor(Math.min(a[0], b[0]) / CELL);
  const lng1 = Math.floor(Math.max(a[0], b[0]) / CELL);
  for (let li = lat0; li <= lat1; li++) {
    for (let gi = lng0; gi <= lng1; gi++) {
      const key = `${li},${gi}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(seg);
      else grid.set(key, [seg]);
    }
  }
}

function eachLine(geom: FeatureLike["geometry"], fn: (line: LngLat[]) => void): void {
  if (!geom) return;
  if (geom.type === "LineString") fn(geom.coordinates as LngLat[]);
  else if (geom.type === "MultiLineString")
    for (const line of geom.coordinates as LngLat[][]) fn(line);
}

/** Index every speed feature posted ≥ minMph into a spatial grid. */
export function buildFastSpeedGrid(speeds: FCLike, minMph = MIN_FAST_MPH): FastGrid {
  const grid: FastGrid = new Map();
  for (const feat of speeds.features ?? []) {
    const mph = Number(feat.properties?.["mph"]);
    if (!Number.isFinite(mph) || mph < minMph) continue;
    eachLine(feat.geometry, (line) => {
      for (let i = 0; i < line.length - 1; i++) addSeg(grid, line[i], line[i + 1]);
    });
  }
  return grid;
}

/** Whether a point (with travel bearing) lies on/along a fast street. */
export function isOnFast(M: LngLat, brg: number, grid: FastGrid): boolean {
  const cellLat = Math.floor(M[1] / CELL);
  const cellLng = Math.floor(M[0] / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        if (bearingDiff(brg, seg.bearing) > BEARING_TOL_DEG) continue;
        if (perpDistanceM(M, seg.a, seg.b) <= THRESHOLD_M) return true;
      }
    }
  }
  return false;
}

/** Index every arterial feature (arterials.geojson is already filtered to
 * tertiary/secondary/primary/trunk/motorway) into a spatial grid, carrying each
 * way's OSM `lanes` count (0 when untagged) on its segments. Same Seg shape +
 * tolerances as the fast-speed join; the lane count drives the caution gradient
 * (see cautionTier / maxLanesAlong). */
export function buildArterialLaneGrid(arterials: FCLike): FastGrid {
  const grid: FastGrid = new Map();
  for (const feat of arterials.features ?? []) {
    const raw = Number(feat.properties?.["lanes"]);
    const lanes = Number.isFinite(raw) ? raw : 0;
    eachLine(feat.geometry, (line) => {
      for (let i = 0; i < line.length - 1; i++) addSeg(grid, line[i], line[i + 1], lanes);
    });
  }
  return grid;
}

/** True if ANY sub-segment of the feature runs along a street in `grid`
 * (fast-speed grid or arterial grid — same Seg shape + tolerances). */
function featureIsFast(geom: FeatureLike["geometry"], grid: FastGrid): boolean {
  let fast = false;
  eachLine(geom, (line) => {
    if (fast) return;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      if (isOnFast(mid, bearing(a, b), grid)) {
        fast = true;
        return;
      }
    }
  });
  return fast;
}

/** Max OSM `lanes` count of any arterial segment the feature runs along, or -1
 * if it runs along NO arterial. A feature on an arterial whose `lanes` is
 * untagged returns 0 (still "on an arterial", just unknown width → lightest
 * caution tier). Mirrors isOnFast's cell scan + tolerances. */
function maxLanesAlong(geom: FeatureLike["geometry"], grid: FastGrid): number {
  let best = -1;
  eachLine(geom, (line) => {
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const M: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const brg = bearing(a, b);
      const cellLat = Math.floor(M[1] / CELL);
      const cellLng = Math.floor(M[0] / CELL);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
          if (!bucket) continue;
          for (const seg of bucket) {
            if (bearingDiff(brg, seg.bearing) > BEARING_TOL_DEG) continue;
            if (perpDistanceM(M, seg.a, seg.b) > THRESHOLD_M) continue;
            if (seg.lanes > best) best = seg.lanes;
          }
        }
      }
    }
  });
  return best;
}

/** Lane count → caution render tier (orange gradient; darker = more lanes).
 * "one more lane is one more lane" — graded rather than a single 4+ cliff. */
function cautionTier(lanes: number): "caution2" | "caution3" | "caution4" {
  if (lanes >= MIN_STROAD_LANES) return "caution4";
  if (lanes === 3) return "caution3";
  return "caution2";
}

/**
 * Mutate each bike feature in place, adding `rclass`: the facility `class`,
 * down-rated when the road context makes it stressful.
 *
 *   "busy" (red — danger):
 *   - any unprotected lane (lane/buffered/shared) along a ≥ minMph FAST street.
 *     A painted facility stranded on a 40+ mph road is the danger signal.
 *
 *   "caution2/3/4" (orange gradient — a lane, but a stressful street; darker as
 *   the road widens; all count toward route comfort-coverage):
 *   - a plain unbuffered lane (PBOT "lane"/BL) along an arterial, graded by the
 *     arterial's OSM `lanes`: ≤2 → caution2, 3 → caution3, 4+ → caution4. The
 *     door-zone collector-lane case (e.g. NE 7th Ave is 3-lane → caution3; SE
 *     Irving / NE 16th are 1–2 lane → caution2). Buffered lanes (BBL) are spared
 *     unless the road is a 4+ lane stroad (below). Mirrors the graded BRouter
 *     self-build weaklane penalty. Skipped when `arterials` is omitted.
 *   - any OTHER unprotected facility (buffered/shared) along a MULTI-LANE stroad
 *     (`lanes` ≥ MIN_STROAD_LANES, e.g. Foster/Powell) → caution4. Spares calm
 *     2–3 lane buffered lanes. A plain lane on the same stroad already lands on
 *     caution4 via the gradient above, so the two never split colors.
 *
 * Returns a per-tier count summary. Separated facilities are never down-rated.
 */
export function bakeRenderClass(
  bikeFeatures: FeatureLike[],
  speeds: FCLike,
  minMph = MIN_FAST_MPH,
  arterials?: FCLike
): { busy: number; caution2: number; caution3: number; caution4: number; total: number } {
  const grid = buildFastSpeedGrid(speeds, minMph);
  const arterialGrid = arterials ? buildArterialLaneGrid(arterials) : null;
  const counts = { busy: 0, caution2: 0, caution3: 0, caution4: 0 };
  for (const f of bikeFeatures) {
    const cls = String(f.properties?.["class"] ?? "");
    let rclass = cls;
    if (cls && !STRONG.has(cls) && featureIsFast(f.geometry, grid)) {
      rclass = "busy";
    } else if (arterialGrid && cls && !STRONG.has(cls)) {
      const lanes = maxLanesAlong(f.geometry, arterialGrid);
      if (lanes >= 0) {
        // On an arterial. A plain painted lane is always down-rated (graded by
        // width); buffered/shared only on a genuine 4+ lane stroad.
        if (cls === ARTERIAL_DOWNRATE_CLASS) rclass = cautionTier(lanes);
        else if (lanes >= MIN_STROAD_LANES) rclass = "caution4";
      }
    }
    if (f.properties) f.properties["rclass"] = rclass;
    if (rclass !== cls && rclass in counts) counts[rclass as keyof typeof counts]++;
  }
  return { ...counts, total: bikeFeatures.length };
}
