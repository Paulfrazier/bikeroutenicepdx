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
 *      Its class → tier; no match → red.
 *   4. Hysteresis smoothing: short contiguous runs fold into the preceding run.
 *   5. Coverage = (green + amber length) / total length.
 */

import { haversineLength } from "./geo";
import type { LngLat } from "./types";

// ── Tuning constants (KEEP IN SYNC WITH iOS) ────────────────────────────────

/** Grid cell size in degrees (~33 m at Portland latitude). */
const CELL = 0.0003;
/** Max perpendicular distance (m) for a route point to "be on" a facility. */
const THRESHOLD_M = 20;
/** Max bearing difference (deg, folded into 0–90) for an alignment match. */
const BEARING_TOL_DEG = 35;
/** Contiguous runs shorter than this (m) merge into the preceding run's tier. */
const MIN_RUN_M = 25;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
// Equirectangular meters-per-degree factors (per algorithm spec).
const M_PER_DEG_LNG = 111320; // scaled by cos(lat) at use-site
const M_PER_DEG_LAT = 110540;

export type Tier = "green" | "amber" | "red";

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

/** Fetch + index the bike network once; cached for the page lifetime. */
export function loadNetworkIndex(
  url = "/bike-network.geojson"
): Promise<Grid> {
  if (!indexPromise) indexPromise = buildIndex(url);
  return indexPromise;
}

// ── Classification ──────────────────────────────────────────────────────────

/** Tier each route segment by nearest aligned network segment. */
function rawTiers(coords: LngLat[], grid: Grid): Tier[] {
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
    tiers[i] = bestTier ?? "red";
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
  const grid = await loadNetworkIndex();
  const tiers = smoothTiers(coords, rawTiers(coords, grid));

  let total = 0;
  let good = 0;
  for (let i = 0; i < tiers.length; i++) {
    const len = haversineLength([coords[i], coords[i + 1]]);
    total += len;
    if (tiers[i] === "green" || tiers[i] === "amber") good += len;
  }
  return { tiers, coverage: total > 0 ? good / total : 0 };
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
