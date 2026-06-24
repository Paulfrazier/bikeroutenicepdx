/**
 * render-class.ts — bake a per-feature `rclass` (render class) onto the bike
 * network by joining it against PBOT posted speeds.
 *
 * WHY: the map overlay and the route line are both colored by a feature's class.
 * An UNPROTECTED on-street lane (buffered/lane/shared) that runs along a FAST
 * street (posted ≥ MIN_FAST_MPH) is stressful regardless of the paint, so we
 * down-rate it to "busy" (red) — the SAME signal the route classifier applies —
 * so the static overlay and the route never disagree, and Lombard/MLK read red
 * on the map before you even route on them. Physically separated facilities
 * (protected / greenway / path) are NEVER down-rated.
 *
 * The downgrade keys off POSTED SPEED only (not the bicycle high-crash layer) so
 * it lines up with the BRouter `safety-ultra` maxspeed penalty, which can only
 * see OSM `maxspeed`. Threshold is shared by both surfaces (see MIN_FAST_MPH).
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

/** Facility classes that are physically separated/calmed — never down-rated. */
const STRONG = new Set(["protected", "greenway", "path"]);

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

/** True if ANY sub-segment of the feature runs along a fast street. */
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
 * except an unprotected lane on a fast street → "busy". Returns a count summary.
 */
export function bakeRenderClass(
  bikeFeatures: FeatureLike[],
  speeds: FCLike,
  minMph = MIN_FAST_MPH
): { downgraded: number; total: number } {
  const grid = buildFastSpeedGrid(speeds, minMph);
  let downgraded = 0;
  for (const f of bikeFeatures) {
    const cls = String(f.properties?.["class"] ?? "");
    let rclass = cls;
    if (cls && !STRONG.has(cls) && featureIsFast(f.geometry, grid)) {
      rclass = "busy";
      downgraded++;
    }
    if (f.properties) f.properties["rclass"] = rclass;
  }
  return { downgraded, total: bikeFeatures.length };
}
