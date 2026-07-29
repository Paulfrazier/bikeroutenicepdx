/**
 * turn-detect.ts — geometry-only turn detection for BRouter routes.
 *
 * BRouter returns bare geometry; the preferred step source is a Valhalla
 * trace_route map-match. When Valhalla is unavailable this module recovers real
 * maneuvers ("turn left", "bear right") from the polyline itself so guidance
 * never degrades to unnamed "Continue" runs.
 *
 * Method: at each vertex, compare the bearing over a ~15 m window behind vs.
 * ahead (windowed, not vertex-to-vertex — BRouter geometry is dense and curvy
 * paths would otherwise spray false turns). A 90° corner drawn as many small
 * vertices still reads as one turn because the windows straddle the whole
 * corner; a gentle road curve accumulates only a few degrees per window and
 * stays below threshold. Same-direction candidates within ~20 m merge to the
 * sharpest vertex; opposite-direction neighbors survive (a real zigzag).
 *
 * Dependency-free and pure — unit-tested by tests/turn-detect/run.ts.
 */

/** Bearing sampling window, meters each side of the vertex. */
const BEARING_WINDOW_M = 15;
/** Minimum absolute bearing change to call something a turn. */
const MIN_TURN_DEG = 28;
/** Same-direction candidates within this arc distance are one physical corner. */
const MERGE_GAP_M = 20;
/** Ignore vertices this close to the route ends (GPS-snap artifacts). */
const END_GUARD_M = 10;

export interface TurnPoint {
  /** Vertex index into the input coords. */
  index: number;
  /** Arc-length position of the vertex along the route, meters. */
  arc: number;
  /** Signed bearing change, degrees; negative = left, positive = right. */
  turnDeg: number;
  /** Valhalla-vocabulary maneuver tag (left, slight_right, u_turn_left, …). */
  maneuver_type: string;
  location: [number, number]; // [lng, lat]
}

const M_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

function distMeters(a: [number, number], b: [number, number]): number {
  const mLng = metersPerDegLng((a[1] + b[1]) / 2);
  return Math.hypot((a[0] - b[0]) * mLng, (a[1] - b[1]) * M_PER_DEG_LAT);
}

/** Compass bearing a→b in degrees [0, 360). */
export function bearingDeg(a: [number, number], b: [number, number]): number {
  const mLng = metersPerDegLng((a[1] + b[1]) / 2);
  const dx = (b[0] - a[0]) * mLng;
  const dy = (b[1] - a[1]) * M_PER_DEG_LAT;
  const deg = (Math.atan2(dx, dy) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** Signed smallest angle from bearing `from` to bearing `to`, in (-180, 180]. */
export function signedBearingDelta(from: number, to: number): number {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Cumulative arc length (m) at each vertex; arcs[0] = 0. */
export function cumulativeArcs(coords: [number, number][]): number[] {
  const arcs = new Array<number>(coords.length);
  arcs[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    arcs[i] = arcs[i - 1] + distMeters(coords[i - 1], coords[i]);
  }
  return arcs;
}

/** Interpolated point at arc-length `target` along the polyline. */
export function pointAtArc(
  coords: [number, number][],
  arcs: number[],
  target: number
): [number, number] {
  if (target <= 0) return coords[0];
  const total = arcs[arcs.length - 1];
  if (target >= total) return coords[coords.length - 1];
  // Binary search for the containing segment.
  let lo = 0;
  let hi = arcs.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (arcs[mid] <= target) lo = mid;
    else hi = mid;
  }
  const span = arcs[hi] - arcs[lo];
  const t = span > 0 ? (target - arcs[lo]) / span : 0;
  return [
    coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t,
    coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t,
  ];
}

/** Closest point to `p` on segment a→b, computed in a local metric frame. */
function closestPointOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): [number, number] {
  const mLng = metersPerDegLng(p[1]);
  const ax = (a[0] - p[0]) * mLng;
  const ay = (a[1] - p[1]) * M_PER_DEG_LAT;
  const bx = (b[0] - p[0]) * mLng;
  const by = (b[1] - p[1]) * M_PER_DEG_LAT;
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : (-ax * dx - ay * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return [
    p[0] + (ax + t * dx) / mLng,
    p[1] + (ay + t * dy) / M_PER_DEG_LAT,
  ];
}

/**
 * Where `target` falls ALONG the polyline, as arc length (m) from the start.
 *
 * Mirrors the web's `geo.ts arcLengthAt`, with one addition: `minArc` floors the
 * search so a sequence of points is resolved monotonically. That matters for
 * multi-stop routes — on a loop or any self-intersecting route the same
 * coordinate projects onto two places on the line, and without the floor a later
 * stop could land before an earlier one and invert the legs.
 */
export function arcLengthAt(
  target: [number, number],
  coords: [number, number][],
  arcs: number[],
  minArc = 0
): number {
  if (coords.length < 2) return 0;
  let bestDist = Infinity;
  let bestArc = minArc;
  for (let i = 0; i < coords.length - 1; i++) {
    // Skip segments that end before the floor — they belong to an earlier stop.
    if (arcs[i + 1] < minArc) continue;
    const proj = closestPointOnSegment(target, coords[i], coords[i + 1]);
    const d = distMeters(target, proj);
    if (d < bestDist) {
      bestDist = d;
      bestArc = Math.max(minArc, arcs[i] + distMeters(coords[i], proj));
    }
  }
  return bestArc;
}

function classifyTurn(deg: number): string {
  const side = deg < 0 ? "left" : "right";
  const a = Math.abs(deg);
  if (a > 165) return `u_turn_${side}`;
  if (a > 120) return `sharp_${side}`;
  if (a > 55) return side;
  return `slight_${side}`;
}

/**
 * Detect turn maneuvers along a route polyline. Coordinates are [lng, lat].
 * Returned turns are ordered along the route.
 */
export function detectTurns(coords: [number, number][]): TurnPoint[] {
  if (coords.length < 3) return [];
  const arcs = cumulativeArcs(coords);
  const total = arcs[arcs.length - 1];
  if (total < END_GUARD_M * 2) return [];

  interface Candidate {
    index: number;
    arc: number;
    delta: number;
  }
  const candidates: Candidate[] = [];
  for (let i = 1; i < coords.length - 1; i++) {
    const arc = arcs[i];
    if (arc < END_GUARD_M || total - arc < END_GUARD_M) continue;
    const behind = pointAtArc(coords, arcs, arc - BEARING_WINDOW_M);
    const ahead = pointAtArc(coords, arcs, arc + BEARING_WINDOW_M);
    if (distMeters(behind, coords[i]) < 1 || distMeters(coords[i], ahead) < 1) continue;
    const delta = signedBearingDelta(
      bearingDeg(behind, coords[i]),
      bearingDeg(coords[i], ahead)
    );
    if (Math.abs(delta) >= MIN_TURN_DEG) candidates.push({ index: i, arc, delta });
  }

  // Merge same-direction runs (one physical corner spans several dense
  // vertices) down to the sharpest vertex; keep opposite-direction neighbors.
  const merged: Candidate[] = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (
      last &&
      Math.sign(last.delta) === Math.sign(c.delta) &&
      c.arc - last.arc <= MERGE_GAP_M
    ) {
      if (Math.abs(c.delta) > Math.abs(last.delta)) merged[merged.length - 1] = c;
    } else {
      merged.push(c);
    }
  }

  return merged.map((c) => ({
    index: c.index,
    arc: c.arc,
    turnDeg: c.delta,
    maneuver_type: classifyTurn(c.delta),
    location: coords[c.index],
  }));
}
