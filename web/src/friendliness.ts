/**
 * friendliness.ts — client-side route classification.
 *
 * Colors a fetched (or hand-edited) route to MATCH the bike-map legend: each
 * route segment is tagged with the bike-network facility CLASS it runs on
 * (protected/greenway/path/buffered/lane/shared), so the route is drawn in the
 * same colors as the network overlay beneath it (the white casing keeps it
 * legible). Off-network segments fall back to "quiet" (neutral) or "busy" (the
 * red dashed danger signal). Classified against the bundled bike-network GeoJSON
 * entirely in the browser.
 *
 * This MUST stay in lockstep with the iOS app's classifier — same class set,
 * same colors, same constants, same algorithm.
 *
 * Pipeline:
 *   1. Fetch + parse /bike-network.geojson once (module-level singleton). Flatten
 *      every feature into individual straight segments (a, b, cls, bearing).
 *   2. Index each segment into a spatial grid hash (cell = ~33 m).
 *   3. For each route segment, take its midpoint and find the nearest network
 *      segment within THRESHOLD meters AND bearing-aligned within tolerance —
 *      adopt its facility class. No bike match → consult a second "arterial"
 *      index: on/along a busy road → "busy", otherwise a quiet street → "quiet".
 *   4. Hysteresis smoothing: short contiguous runs fold into the preceding run.
 *   5. Coverage = fraction NOT on a busy no-facility road (everything but "busy").
 */

import { closestPointOnSegmentMeters, haversineLength } from "./geo";
import type { LngLat } from "./types";

// ── Tuning constants (KEEP IN SYNC WITH iOS) ────────────────────────────────

/** Grid cell size in degrees (~33 m at Portland latitude). */
const CELL = 0.0003;
/** Max perpendicular distance (m) for a route point to "be on" a facility. */
const THRESHOLD_M = 20;
/** Max bearing difference (deg, folded into 0–90) for an alignment match. */
const BEARING_TOL_DEG = 35;
/** Max perpendicular distance (m) for a route point to count as "on" a busy
 * arterial (tighter than the bike threshold). */
const ARTERIAL_THRESHOLD_M = 18;
/** Max bearing difference (deg, folded 0–90) for an arterial alignment match. */
const ARTERIAL_BEARING_TOL_DEG = 30;
/** Contiguous runs shorter than this (m) merge into the preceding run's tier. */
const MIN_RUN_M = 25;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
// Equirectangular meters-per-degree factors (per algorithm spec).
const M_PER_DEG_LNG = 111320; // scaled by cos(lat) at use-site
const M_PER_DEG_LAT = 110540;

/**
 * A route segment's category: one of the six bike-network facility classes (so
 * the route matches the bike-map legend exactly) plus two off-network states —
 * "quiet" (calm neighborhood street) and "busy" (the red dashed danger signal).
 */
export type RouteClass =
  | "protected"
  | "greenway"
  | "path"
  | "buffered"
  | "lane"
  | "shared"
  | "quiet"
  | "busy";

/**
 * Route-class → render color. The six facility colors are IDENTICAL to the
 * bike-network overlay (LEGEND_ITEMS in Map.tsx) so one legend explains both the
 * map and the route. KEEP IN SYNC WITH iOS (BikeFriendliness.swift) — the parity
 * guard (scripts/check-parity.ts) compares these pairs.
 */
export const ROUTE_CLASS_COLORS: Record<RouteClass, string> = {
  protected: "#6D28D9",
  greenway: "#2E9E48",
  path: "#B45309",
  buffered: "#0891B2",
  lane: "#F59E0B",
  shared: "#9CA3AF",
  quiet: "#64748B",
  busy: "#DC2626",
};

/** Route classes drawn dashed (shared mirrors the overlay; busy = danger). */
export const ROUTE_CLASS_DASHED: readonly RouteClass[] = ["shared", "busy"];

/** The only class excluded from the comfort-coverage fraction. */
export const DANGER_CLASS: RouteClass = "busy";

export interface RouteFriendliness {
  /** Per-route-segment class; length === coords.length - 1. */
  classes: RouteClass[];
  /** Fraction of total length NOT on a busy no-facility road ("busy" excluded). */
  coverage: number;
}

/** Normalize a raw bike-network `class` value to a known facility class. */
function normalizeClass(cls: string): RouteClass {
  switch (cls) {
    case "protected":
    case "greenway":
    case "path":
    case "buffered":
    case "lane":
    case "shared":
      return cls;
    default:
      return "shared";
  }
}

// ── Geometry helpers ────────────────────────────────────────────────────────

/** Initial bearing a→b in degrees [0, 360). */
function bearing(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const dLng = (b[0] - a[0]) * DEG2RAD;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

/** Direction-agnostic bearing difference, folded into [0, 90]. */
function bearingDiff(b1: number, b2: number): number {
  let d = Math.abs(b1 - b2) % 180;
  if (d > 90) d = 180 - d;
  return d;
}

/**
 * Perpendicular distance (m) from midpoint M to segment a→b via local
 * equirectangular projection centered on M.
 */
function perpDistanceM(M: LngLat, a: LngLat, b: LngLat): number {
  const cosLat = Math.cos(M[1] * DEG2RAD);
  const toXY = (p: LngLat): [number, number] => [
    (p[0] - M[0]) * cosLat * M_PER_DEG_LNG,
    (p[1] - M[1]) * M_PER_DEG_LAT,
  ];
  const [ax, ay] = toXY(a);
  const [bx, by] = toXY(b);
  // M is the origin (0, 0) by construction.
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(ax, ay);
  let t = (-ax * dx - ay * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

// ── Network spatial index ───────────────────────────────────────────────────

interface NetSegment {
  a: LngLat;
  b: LngLat;
  cls: RouteClass;
  bearing: number;
}

type Grid = Map<string, NetSegment[]>;

function addToGrid(grid: Grid, seg: NetSegment): void {
  const minLat = Math.min(seg.a[1], seg.b[1]);
  const maxLat = Math.max(seg.a[1], seg.b[1]);
  const minLng = Math.min(seg.a[0], seg.b[0]);
  const maxLng = Math.max(seg.a[0], seg.b[0]);
  const lat0 = Math.floor(minLat / CELL);
  const lat1 = Math.floor(maxLat / CELL);
  const lng0 = Math.floor(minLng / CELL);
  const lng1 = Math.floor(maxLng / CELL);
  for (let li = lat0; li <= lat1; li++) {
    for (let gi = lng0; gi <= lng1; gi++) {
      const key = `${li},${gi}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(seg);
      else grid.set(key, [seg]);
    }
  }
}

/** Push every straight piece of a coordinate ring into the grid. */
function indexLineString(grid: Grid, coords: LngLat[], cls: RouteClass): void {
  if (coords.length < 2) return;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    addToGrid(grid, { a, b, cls, bearing: bearing(a, b) });
  }
}

async function buildIndex(url: string): Promise<Grid> {
  const grid: Grid = new Map();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bike-network fetch failed: ${res.status}`);
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  for (const feat of fc.features ?? []) {
    const cls = normalizeClass((feat.properties?.class as string | undefined) ?? "shared");
    const geom = feat.geometry;
    if (!geom) continue;
    if (geom.type === "LineString") {
      indexLineString(grid, geom.coordinates as LngLat[], cls);
    } else if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates) {
        indexLineString(grid, line as LngLat[], cls);
      }
    }
  }
  return grid;
}

let indexPromise: Promise<Grid> | null = null;
// Resolved grid cached for synchronous use (snapToNetwork during a drag). Set
// once the async build completes; null until then (snap falls back to raw).
let resolvedGrid: Grid | null = null;

/** Fetch + index the bike network once; cached for the page lifetime. */
export function loadNetworkIndex(
  url = "/bike-network.geojson"
): Promise<Grid> {
  if (!indexPromise) {
    indexPromise = buildIndex(url).then((grid) => {
      resolvedGrid = grid;
      return grid;
    });
  }
  return indexPromise;
}

/**
 * Snap `target` onto the nearest bike-network edge, in lng/lat. Returns the
 * snapped point if a segment lies within `maxMeters`, else null (caller keeps
 * the raw point so off-network drags still route).
 *
 * Synchronous: uses the resolved grid if it's loaded, otherwise kicks off the
 * load and returns null this time. Snaps to ANY facility tier — we want the
 * waypoint on a real path, not necessarily a greenway.
 */
export function snapToNetwork(
  target: LngLat,
  // Generous by default: a NORMAL drag should always land on a real bikeable
  // street near the finger (so the route bulges locally instead of flying off
  // to a far graph node). Precise anchors never call this — they stay exact.
  maxMeters = 100
): LngLat | null {
  const grid = resolvedGrid;
  if (!grid) {
    void loadNetworkIndex(); // warm the cache for next time
    return null;
  }
  const cellLat = Math.floor(target[1] / CELL);
  const cellLng = Math.floor(target[0] / CELL);
  // Search a neighborhood wide enough to cover maxMeters (CELL ≈ 33 m).
  const reach = Math.max(1, Math.ceil(maxMeters / (CELL * M_PER_DEG_LAT)));
  let bestDist = maxMeters;
  let best: LngLat | null = null;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        const pt = closestPointOnSegmentMeters(target, seg.a, seg.b);
        const d = haversineLength([target, pt]);
        if (d < bestDist) {
          bestDist = d;
          best = pt;
        }
      }
    }
  }
  return best;
}

// ── Arterial spatial index ──────────────────────────────────────────────────
// A second, lighter index over Portland's busy roads (motorway…tertiary). When
// a route segment matches no bike facility, proximity to an arterial decides
// red ("mixed with fast traffic") vs calm (quiet neighborhood street).

interface ArtSegment {
  a: LngLat;
  b: LngLat;
  bearing: number;
}

type ArtGrid = Map<string, ArtSegment[]>;

function addArtToGrid(grid: ArtGrid, seg: ArtSegment): void {
  const lat0 = Math.floor(Math.min(seg.a[1], seg.b[1]) / CELL);
  const lat1 = Math.floor(Math.max(seg.a[1], seg.b[1]) / CELL);
  const lng0 = Math.floor(Math.min(seg.a[0], seg.b[0]) / CELL);
  const lng1 = Math.floor(Math.max(seg.a[0], seg.b[0]) / CELL);
  for (let li = lat0; li <= lat1; li++) {
    for (let gi = lng0; gi <= lng1; gi++) {
      const key = `${li},${gi}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(seg);
      else grid.set(key, [seg]);
    }
  }
}

function indexArtLineString(grid: ArtGrid, coords: LngLat[]): void {
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    addArtToGrid(grid, { a, b, bearing: bearing(a, b) });
  }
}

async function buildArterialIndex(url: string): Promise<ArtGrid> {
  const grid: ArtGrid = new Map();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arterials fetch failed: ${res.status}`);
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  for (const feat of fc.features ?? []) {
    const geom = feat.geometry;
    if (!geom) continue;
    if (geom.type === "LineString") {
      indexArtLineString(grid, geom.coordinates as LngLat[]);
    } else if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates) indexArtLineString(grid, line as LngLat[]);
    }
  }
  return grid;
}

let artIndexPromise: Promise<ArtGrid> | null = null;

/** Fetch + index the arterial network once; cached for the page lifetime. */
export function loadArterialIndex(
  url = "/arterials.geojson"
): Promise<ArtGrid> {
  if (!artIndexPromise) artIndexPromise = buildArterialIndex(url);
  return artIndexPromise;
}

/** Whether a route-segment midpoint sits on/along a busy arterial. */
function isOnArterial(M: LngLat, routeBearing: number, artGrid: ArtGrid): boolean {
  const cellLat = Math.floor(M[1] / CELL);
  const cellLng = Math.floor(M[0] / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = artGrid.get(`${cellLat + dy},${cellLng + dx}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        if (bearingDiff(routeBearing, seg.bearing) > ARTERIAL_BEARING_TOL_DEG) continue;
        if (perpDistanceM(M, seg.a, seg.b) <= ARTERIAL_THRESHOLD_M) return true;
      }
    }
  }
  return false;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify each route segment. First try to match a nearby bike facility and
 * adopt its class (so the route matches the bike-map legend). If none matches,
 * fall back to the arterial index: on/along a busy road → "busy" (danger),
 * otherwise a quiet neighborhood street → "quiet".
 */
function rawClasses(coords: LngLat[], grid: Grid, artGrid: ArtGrid): RouteClass[] {
  const n = coords.length - 1;
  const classes: RouteClass[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const M: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const routeBearing = bearing(a, b);
    const cellLat = Math.floor(M[1] / CELL);
    const cellLng = Math.floor(M[0] / CELL);

    let bestDist = THRESHOLD_M;
    let bestClass: RouteClass | null = null;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          if (bearingDiff(routeBearing, seg.bearing) > BEARING_TOL_DEG) continue;
          const d = perpDistanceM(M, seg.a, seg.b);
          if (d < bestDist) {
            bestDist = d;
            bestClass = seg.cls;
          }
        }
      }
    }
    if (bestClass) {
      classes[i] = bestClass;
    } else {
      // No bike facility — busy arterial nearby → danger, else quiet street.
      classes[i] = isOnArterial(M, routeBearing, artGrid) ? "busy" : "quiet";
    }
  }
  return classes;
}

/** Fold short contiguous runs into the preceding run's class (hysteresis). */
function smoothClasses(coords: LngLat[], classes: RouteClass[]): RouteClass[] {
  const n = classes.length;
  if (n === 0) return classes;

  const segLen: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    segLen[i] = haversineLength([coords[i], coords[i + 1]]);
  }

  interface Run {
    cls: RouteClass;
    start: number;
    end: number;
    len: number;
  }
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && last.cls === classes[i]) {
      last.end = i;
      last.len += segLen[i];
    } else {
      runs.push({ cls: classes[i], start: i, end: i, len: segLen[i] });
    }
  }

  // First run keeps its class; each later short run adopts the preceding class.
  for (let k = 1; k < runs.length; k++) {
    if (runs[k].len < MIN_RUN_M) runs[k].cls = runs[k - 1].cls;
  }

  const out: RouteClass[] = new Array(n);
  for (const run of runs) {
    for (let i = run.start; i <= run.end; i++) out[i] = run.cls;
  }
  return out;
}

/**
 * Classify a route's coordinates into per-segment tiers + a coverage fraction.
 * Resolves the network index on first call, then runs synchronously.
 */
export async function classifyRoute(
  coords: LngLat[]
): Promise<RouteFriendliness> {
  if (coords.length < 2) return { classes: [], coverage: 0 };
  const [grid, artGrid] = await Promise.all([
    loadNetworkIndex(),
    loadArterialIndex(),
  ]);
  const classes = smoothClasses(coords, rawClasses(coords, grid, artGrid));

  // Coverage = fraction NOT on a busy no-facility road. Every facility class and
  // a quiet street all count as comfortable; only "busy" — a busy street with no
  // bike lane (the danger signal) — is excluded.
  let total = 0;
  let comfortable = 0;
  for (let i = 0; i < classes.length; i++) {
    const len = haversineLength([coords[i], coords[i + 1]]);
    total += len;
    if (classes[i] !== DANGER_CLASS) comfortable += len;
  }
  return { classes, coverage: total > 0 ? comfortable / total : 0 };
}

// ── Rendering helper ────────────────────────────────────────────────────────

/**
 * Split a route into one LineString feature per contiguous class-run, each
 * tagged with `properties.class`, for MapLibre rendering.
 */
export function toRouteClassFeatureCollection(
  coords: LngLat[],
  classes: RouteClass[]
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (coords.length < 2 || classes.length === 0) {
    return { type: "FeatureCollection", features };
  }
  let runStart = 0;
  for (let i = 1; i <= classes.length; i++) {
    if (i === classes.length || classes[i] !== classes[runStart]) {
      // Segments [runStart, i-1] map to coords [runStart, i].
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords.slice(runStart, i + 1),
        },
        properties: { class: classes[runStart] },
      });
      runStart = i;
    }
  }
  return { type: "FeatureCollection", features };
}
