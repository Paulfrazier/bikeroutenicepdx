/**
 * friendliness.ts — client-side bike-friendliness classification.
 *
 * Colors a fetched (or hand-edited) route by a 3-tier "traffic-light" scheme,
 * classified against the bundled bike-network GeoJSON entirely in the browser.
 *
 * This MUST stay in lockstep with the iOS app's classifier — same tier mapping,
 * same constants, same algorithm.
 *
 * Pipeline:
 *   1. Fetch + parse /bike-network.geojson once (module-level singleton). Flatten
 *      every feature into individual straight segments (a, b, tier, bearing).
 *   2. Index each segment into a spatial grid hash (cell = ~33 m).
 *   3. For each route segment, take its midpoint and find the nearest network
 *      segment within THRESHOLD meters AND bearing-aligned within tolerance.
 *      Its class → tier. No bike match → consult a second "arterial" index:
 *      on/along a busy road → red, otherwise a quiet street → calm.
 *   4. Hysteresis smoothing: short contiguous runs fold into the preceding run.
 *   5. Coverage = fraction NOT on a busy road (green + amber + calm) / total.
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

export type Tier = "green" | "amber" | "calm" | "red";

export interface RouteFriendliness {
  /** Per-route-segment tier; length === coords.length - 1. */
  tiers: Tier[];
  /** Fraction of total length on green+amber facilities (red excluded). */
  coverage: number;
}

/** Map a network facility class to a friendliness tier. */
function classToTier(cls: string): Tier {
  switch (cls) {
    case "protected":
    case "greenway":
    case "path":
      return "green";
    case "buffered":
    case "lane":
      return "amber";
    case "shared":
    default:
      return "red";
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
  tier: Tier;
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
function indexLineString(grid: Grid, coords: LngLat[], tier: Tier): void {
  if (coords.length < 2) return;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    addToGrid(grid, { a, b, tier, bearing: bearing(a, b) });
  }
}

async function buildIndex(url: string): Promise<Grid> {
  const grid: Grid = new Map();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bike-network fetch failed: ${res.status}`);
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  for (const feat of fc.features ?? []) {
    const cls = (feat.properties?.class as string | undefined) ?? "shared";
    const tier = classToTier(cls);
    const geom = feat.geometry;
    if (!geom) continue;
    if (geom.type === "LineString") {
      indexLineString(grid, geom.coordinates as LngLat[], tier);
    } else if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates) {
        indexLineString(grid, line as LngLat[], tier);
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
  maxMeters = 60
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
 * Tier each route segment. First try to match a nearby bike facility
 * (green/amber). If none matches, fall back to the arterial index: on/along a
 * busy road → red, otherwise a quiet neighborhood street → calm.
 */
function rawTiers(coords: LngLat[], grid: Grid, artGrid: ArtGrid): Tier[] {
  const n = coords.length - 1;
  const tiers: Tier[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const M: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const routeBearing = bearing(a, b);
    const cellLat = Math.floor(M[1] / CELL);
    const cellLng = Math.floor(M[0] / CELL);

    let bestDist = THRESHOLD_M;
    let bestTier: Tier | null = null;

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          if (bearingDiff(routeBearing, seg.bearing) > BEARING_TOL_DEG) continue;
          const d = perpDistanceM(M, seg.a, seg.b);
          if (d < bestDist) {
            bestDist = d;
            bestTier = seg.tier;
          }
        }
      }
    }
    if (bestTier) {
      tiers[i] = bestTier;
    } else {
      // No bike facility — busy arterial nearby → red, else calm quiet street.
      tiers[i] = isOnArterial(M, routeBearing, artGrid) ? "red" : "calm";
    }
  }
  return tiers;
}

/** Fold short contiguous runs into the preceding run's tier (hysteresis). */
function smoothTiers(coords: LngLat[], tiers: Tier[]): Tier[] {
  const n = tiers.length;
  if (n === 0) return tiers;

  const segLen: number[] = new Array(n);
  for (let i = 0; i < n; i++) {
    segLen[i] = haversineLength([coords[i], coords[i + 1]]);
  }

  interface Run {
    tier: Tier;
    start: number;
    end: number;
    len: number;
  }
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    const last = runs[runs.length - 1];
    if (last && last.tier === tiers[i]) {
      last.end = i;
      last.len += segLen[i];
    } else {
      runs.push({ tier: tiers[i], start: i, end: i, len: segLen[i] });
    }
  }

  // First run keeps its tier; each later short run adopts the preceding tier.
  for (let k = 1; k < runs.length; k++) {
    if (runs[k].len < MIN_RUN_M) runs[k].tier = runs[k - 1].tier;
  }

  const out: Tier[] = new Array(n);
  for (const run of runs) {
    for (let i = run.start; i <= run.end; i++) out[i] = run.tier;
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
  if (coords.length < 2) return { tiers: [], coverage: 0 };
  const [grid, artGrid] = await Promise.all([
    loadNetworkIndex(),
    loadArterialIndex(),
  ]);
  const tiers = smoothTiers(coords, rawTiers(coords, grid, artGrid));

  // Coverage = fraction NOT on a busy road (green + amber + calm all count as
  // comfortable; only red — a busy street with no bike lane — is excluded).
  let total = 0;
  let comfortable = 0;
  for (let i = 0; i < tiers.length; i++) {
    const len = haversineLength([coords[i], coords[i + 1]]);
    total += len;
    if (tiers[i] !== "red") comfortable += len;
  }
  return { tiers, coverage: total > 0 ? comfortable / total : 0 };
}

// ── Rendering helper ────────────────────────────────────────────────────────

/**
 * Split a route into one LineString feature per contiguous tier-run, each
 * tagged with `properties.tier`, for MapLibre rendering.
 */
export function toTierFeatureCollection(
  coords: LngLat[],
  tiers: Tier[]
): GeoJSON.FeatureCollection {
  const features: GeoJSON.Feature[] = [];
  if (coords.length < 2 || tiers.length === 0) {
    return { type: "FeatureCollection", features };
  }
  let runStart = 0;
  for (let i = 1; i <= tiers.length; i++) {
    if (i === tiers.length || tiers[i] !== tiers[runStart]) {
      // Segments [runStart, i-1] map to coords [runStart, i].
      features.push({
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates: coords.slice(runStart, i + 1),
        },
        properties: { tier: tiers[runStart] },
      });
      runStart = i;
    }
  }
  return { type: "FeatureCollection", features };
}
