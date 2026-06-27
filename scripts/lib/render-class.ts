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
 * a slower arterial or a multi-lane stroad — down-rates only to "caution"
 * (orange): still a lane, just a stressful street, distinct from the red danger
 * signal (see bakeRenderClass). Physically separated facilities (protected /
 * greenway / path) are NEVER down-rated.
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

/** Facility classes that are physically separated/calmed — never down-rated. */
const STRONG = new Set(["protected", "greenway", "path"]);

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

function addSeg(grid: FastGrid, a: LngLat, b: LngLat): void {
  const seg: Seg = { a, b, bearing: bearing(a, b) };
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
 * tertiary/secondary/primary/trunk/motorway) into a spatial grid. Reuses the
 * same Seg grid + tolerances as the fast-speed join. */
export function buildArterialGrid(arterials: FCLike): FastGrid {
  const grid: FastGrid = new Map();
  for (const feat of arterials.features ?? []) {
    eachLine(feat.geometry, (line) => {
      for (let i = 0; i < line.length - 1; i++) addSeg(grid, line[i], line[i + 1]);
    });
  }
  return grid;
}

/** Index only the MULTI-LANE arterials (OSM `lanes` ≥ minLanes) into a spatial
 * grid — the wide stroads whose unprotected bike lanes are stressful regardless
 * of posted speed. Ways without a numeric `lanes` tag are skipped (conservative:
 * an untagged way is never assumed wide). Same Seg shape + tolerances as the
 * other grids. */
export function buildWideArterialGrid(
  arterials: FCLike,
  minLanes = MIN_STROAD_LANES
): FastGrid {
  const grid: FastGrid = new Map();
  for (const feat of arterials.features ?? []) {
    const lanes = Number(feat.properties?.["lanes"]);
    if (!Number.isFinite(lanes) || lanes < minLanes) continue;
    eachLine(feat.geometry, (line) => {
      for (let i = 0; i < line.length - 1; i++) addSeg(grid, line[i], line[i + 1]);
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

/**
 * Mutate each bike feature in place, adding `rclass`: the facility `class`,
 * down-rated when the road context makes it stressful. Two down-rate tiers:
 *
 *   "busy" (red — danger):
 *   1. any unprotected lane (lane/buffered/shared) along a ≥ minMph FAST street.
 *      A painted facility stranded on a 40+ mph road is the danger signal.
 *
 *   "caution" (orange — a lane, but a stressful street; counts toward coverage):
 *   2. a plain unbuffered lane (PBOT "lane"/BL) along an arterial — the door-zone
 *      collector-lane case (e.g. NE 7th Ave, SE Irving: tertiary, posted ~20 mph
 *      so rule 1 misses it). Buffered lanes (BBL) are spared. Mirrors the BRouter
 *      self-build `weaklane` penalty. Skipped when `arterials` is omitted.
 *   3. any unprotected facility (lane/buffered/shared) along a MULTI-LANE stroad
 *      (OSM `lanes` ≥ MIN_STROAD_LANES) — the 30–35 mph 4–5 lane arterials
 *      (Foster/Powell/Holgate/Lombard) that sit below minMph so rule 1 misses
 *      them, but where even a buffered lane is stranded. Spares calm 2–3 lane
 *      buffered lanes. Skipped when `arterials` is omitted or lacks `lanes` tags.
 *      Same tier as rule 2 so a plain lane and a buffered lane on the SAME stroad
 *      never split colors (which would draw the better facility redder).
 *
 * Returns a count summary. Physically separated facilities are never down-rated.
 */
export function bakeRenderClass(
  bikeFeatures: FeatureLike[],
  speeds: FCLike,
  minMph = MIN_FAST_MPH,
  arterials?: FCLike
): { downgraded: number; downgradedArterial: number; downgradedWide: number; total: number } {
  const grid = buildFastSpeedGrid(speeds, minMph);
  const arterialGrid = arterials ? buildArterialGrid(arterials) : null;
  const wideGrid = arterials ? buildWideArterialGrid(arterials) : null;
  let downgraded = 0;
  let downgradedArterial = 0;
  let downgradedWide = 0;
  for (const f of bikeFeatures) {
    const cls = String(f.properties?.["class"] ?? "");
    let rclass = cls;
    if (cls && !STRONG.has(cls) && featureIsFast(f.geometry, grid)) {
      rclass = "busy";
      downgraded++;
    } else if (
      arterialGrid &&
      cls === ARTERIAL_DOWNRATE_CLASS &&
      featureIsFast(f.geometry, arterialGrid)
    ) {
      rclass = "caution";
      downgradedArterial++;
    } else if (
      wideGrid &&
      cls &&
      !STRONG.has(cls) &&
      featureIsFast(f.geometry, wideGrid)
    ) {
      rclass = "caution";
      downgradedWide++;
    }
    if (f.properties) f.properties["rclass"] = rclass;
  }
  return { downgraded, downgradedArterial, downgradedWide, total: bikeFeatures.length };
}
