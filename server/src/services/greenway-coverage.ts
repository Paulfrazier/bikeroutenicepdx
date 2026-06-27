/**
 * greenway-coverage.ts
 *
 * Valhalla cannot return our custom PBOT bicycle_network_class, so we recover it
 * server-side: match each piece of the returned route polyline against the
 * classified PBOT bike network (server/data/bike-network.geojson, produced by
 * scripts/export-bike-network.ts) and label it.
 *
 * Two outputs feed the route response and the test harness:
 *   - per-step `bicycle_network_class` (dominant class along the maneuver)
 *   - overall `greenway_coverage` (share of distance on greenway-equivalent infra)
 *
 * The class vocabulary here mirrors what tests/routes/run.ts expects
 * (off_street | greenway | protected | buffered | standard); the bike-network
 * export uses display classes, mapped via DISPLAY_TO_CLASS below.
 *
 * Dependency-free on purpose (no turf) — a small equirectangular point-to-
 * segment distance is plenty accurate at city scale, and a per-feature bbox
 * prefilter keeps it fast enough for per-request use.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

export type NetworkClass =
  | "off_street"
  | "greenway"
  | "protected"
  | "buffered"
  | "calm"
  | "standard";

/**
 * Greenway-equivalent classes — kept in sync with tests/routes/run.ts
 * (computeCoverage's GREENWAY_CLASSES). These count toward greenway_coverage.
 * `calm` (PBOT SR_LT/SR_MT recommended shared roadways) is deliberately EXCLUDED:
 * it's a quiet street with no built facility, reported separately as
 * `calm_coverage`, never folded into greenway_coverage.
 */
export const GREENWAY_EQUIVALENT: ReadonlySet<NetworkClass> = new Set<NetworkClass>([
  "off_street",
  "greenway",
  "protected",
]);

/** Recommended calm shared-roadway classes (SR_LT/SR_MT) — drive `calm_coverage`,
 * tracked separately from greenway coverage. */
export const CALM_CLASSES: ReadonlySet<NetworkClass> = new Set<NetworkClass>(["calm"]);

/** bike-network.geojson display class → harness NetworkClass. Both calm display
 * classes (SR_LT→calm, SR_MT→calm_mod) collapse to one `calm` coverage bucket. */
const DISPLAY_TO_CLASS: Record<string, NetworkClass> = {
  greenway: "greenway",
  path: "off_street",
  protected: "protected",
  buffered: "buffered",
  calm: "calm",
  calm_mod: "calm",
  lane: "standard",
  shared: "standard",
};

/** A way you can ride on, within this distance (m) of a route point, classifies it. */
const MATCH_TOLERANCE_M = 18;

// ---------------------------------------------------------------------------
// Network index (loaded once, lazily)
// ---------------------------------------------------------------------------

interface Segment {
  coords: [number, number][]; // [lng, lat][]
  cls: NetworkClass;
  // bbox for prefiltering
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

let segments: Segment[] | null = null;

function defaultNetworkPath(): string {
  // server/dist/services/ or server/src/services/ → server/data/bike-network.geojson
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../data/bike-network.geojson");
}

function loadNetwork(): Segment[] {
  if (segments) return segments;

  const file = config.bikeNetworkPath || defaultNetworkPath();
  const out: Segment[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
      features?: Array<{
        geometry: { type: string; coordinates: unknown } | null;
        properties: Record<string, unknown> | null;
      }>;
    };

    for (const f of raw.features ?? []) {
      if (!f.geometry) continue;
      const display = String(f.properties?.["class"] ?? "");
      const cls = DISPLAY_TO_CLASS[display];
      if (!cls) continue;

      const parts: [number, number][][] =
        f.geometry.type === "LineString"
          ? [f.geometry.coordinates as [number, number][]]
          : f.geometry.type === "MultiLineString"
            ? (f.geometry.coordinates as [number, number][][])
            : [];

      for (const coords of parts) {
        if (!Array.isArray(coords) || coords.length < 2) continue;
        let minLng = Infinity,
          minLat = Infinity,
          maxLng = -Infinity,
          maxLat = -Infinity;
        for (const [lng, lat] of coords) {
          if (lng < minLng) minLng = lng;
          if (lat < minLat) minLat = lat;
          if (lng > maxLng) maxLng = lng;
          if (lat > maxLat) maxLat = lat;
        }
        out.push({ coords, cls, minLng, minLat, maxLng, maxLat });
      }
    }
    if (out.length === 0) {
      console.warn(
        `[greenway-coverage] loaded 0 usable segments from ${file} — ` +
          `per-step class + coverage will be empty.`
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[greenway-coverage] could not load bike network from ${file}: ${msg}. ` +
        `Falling back to no classification (coverage 0).`
    );
  }

  segments = out;
  return segments;
}

// ---------------------------------------------------------------------------
// Geometry — equirectangular meters, point-to-segment
// ---------------------------------------------------------------------------

const M_PER_DEG_LAT = 111_320;

function metersPerDegLng(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Great-circle-ish distance between two [lng,lat] points, meters. */
function distMeters(a: [number, number], b: [number, number]): number {
  const mLat = M_PER_DEG_LAT;
  const mLng = metersPerDegLng((a[1] + b[1]) / 2);
  const dx = (a[0] - b[0]) * mLng;
  const dy = (a[1] - b[1]) * mLat;
  return Math.hypot(dx, dy);
}

/** Distance (m) from point P to segment A–B, via local equirectangular projection at P. */
function pointToSegmentMeters(
  p: [number, number],
  a: [number, number],
  b: [number, number]
): number {
  const mLng = metersPerDegLng(p[1]);
  const mLat = M_PER_DEG_LAT;
  // Project to local meters relative to P.
  const ax = (a[0] - p[0]) * mLng;
  const ay = (a[1] - p[1]) * mLat;
  const bx = (b[0] - p[0]) * mLng;
  const by = (b[1] - p[1]) * mLat;
  // P is the origin (0,0). Closest point on segment AB to origin.
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq > 0 ? -(ax * dx + ay * dy) / lenSq : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(cx, cy);
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Classify a single [lng,lat] point: the nearest network class within tolerance, else null. */
export function classifyPoint(lng: number, lat: number): NetworkClass | null {
  const segs = loadNetwork();
  // Pad the bbox prefilter by the tolerance (converted to degrees, generous).
  const padLat = MATCH_TOLERANCE_M / M_PER_DEG_LAT;
  const padLng = MATCH_TOLERANCE_M / Math.max(1, metersPerDegLng(lat));

  let best = Infinity;
  let bestCls: NetworkClass | null = null;
  const p: [number, number] = [lng, lat];

  for (const s of segs) {
    if (
      lng < s.minLng - padLng ||
      lng > s.maxLng + padLng ||
      lat < s.minLat - padLat ||
      lat > s.maxLat + padLat
    ) {
      continue;
    }
    for (let i = 0; i < s.coords.length - 1; i++) {
      const d = pointToSegmentMeters(p, s.coords[i], s.coords[i + 1]);
      if (d < best) {
        best = d;
        bestCls = s.cls;
        if (best === 0) break;
      }
    }
  }

  return best <= MATCH_TOLERANCE_M ? bestCls : null;
}

/**
 * Dominant network class along a polyline: classify each sub-segment (by its
 * midpoint, falling back to endpoints) and length-weight the votes. Returns the
 * class covering the most distance, or null if most of the path is off-network.
 */
export function dominantClass(coords: [number, number][]): NetworkClass | null {
  if (coords.length < 2) {
    if (coords.length === 1) return classifyPoint(coords[0][0], coords[0][1]);
    return null;
  }

  const tally = new Map<NetworkClass | null, number>();
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = distMeters(a, b);
    if (segLen === 0) continue;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const cls =
      classifyPoint(mid[0], mid[1]) ??
      classifyPoint(a[0], a[1]) ??
      classifyPoint(b[0], b[1]);
    tally.set(cls, (tally.get(cls) ?? 0) + segLen);
  }

  let bestCls: NetworkClass | null = null;
  let bestLen = -1;
  for (const [cls, len] of tally) {
    if (len > bestLen) {
      bestLen = len;
      bestCls = cls;
    }
  }
  return bestCls;
}

/** True if a class counts toward greenway coverage. */
export function isGreenwayEquivalent(cls: NetworkClass | null): boolean {
  return cls !== null && GREENWAY_EQUIVALENT.has(cls);
}

// ---------------------------------------------------------------------------
// Facility coverage + corridor finder (PBOT-aware route steering)
// ---------------------------------------------------------------------------

/**
 * Total length (m) of a route polyline whose segments classify (via classifyPoint,
 * midpoint then endpoints) into one of `classes`. The metric primitive for
 * scoring a candidate route by facility type — e.g. pass {buffered, protected}
 * to measure on-bike-lane distance, or GREENWAY_EQUIVALENT for greenway_coverage.
 */
export function facilityMeters(
  coords: [number, number][],
  classes: ReadonlySet<NetworkClass>
): number {
  if (coords.length < 2) return 0;
  let meters = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = distMeters(a, b);
    if (segLen === 0) continue;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const cls =
      classifyPoint(mid[0], mid[1]) ??
      classifyPoint(a[0], a[1]) ??
      classifyPoint(b[0], b[1]);
    if (cls && classes.has(cls)) meters += segLen;
  }
  return meters;
}

export interface FacilityCorridor {
  /** Representative on-facility points, ordered along the origin→dest axis. */
  spine: [number, number][];
  /** Along-corridor span (m) the facility band covers. */
  lengthM: number;
  /** Count of contributing segments per class. */
  classCounts: Record<string, number>;
}

export interface FacilityCorridorOpts {
  halfWidthM?: number; // max perpendicular offset from the OD axis (default 350)
  overshootM?: number; // allow facilities slightly before/after the OD ends (default 150)
  minAlignCos?: number; // min |cos| between facility + OD direction (default 0.6)
  bandM?: number; // offset-clustering band width to isolate one parallel facility (default 120)
  minSpanM?: number; // discard facility bands shorter than this along-corridor (default 120)
  classes?: ReadonlySet<NetworkClass>; // which facility classes to seek (default buffered+protected)
}

/**
 * Find the strongest PBOT facility (buffered/protected by default) running ALONG
 * the straight origin→destination corridor, and return an ordered "spine" of
 * on-facility points. Callers inject one or more spine points as mandatory vias
 * to nudge BRouter onto the lane (BRouter snaps each via to the legal edge).
 *
 * Approach: project every qualifying network segment's midpoint onto the OD axis
 * (along) and its perpendicular (offset); keep those within the corridor window
 * and roughly parallel to it; cluster by offset into bands (so a parallel street
 * a block over is a separate band) and return the band covering the most
 * along-corridor distance. Returns null if nothing qualifies.
 */
export function facilitiesInCorridor(
  from: [number, number],
  to: [number, number],
  opts: FacilityCorridorOpts = {}
): FacilityCorridor | null {
  const halfWidth = opts.halfWidthM ?? 350;
  const overshoot = opts.overshootM ?? 150;
  const minAlignCos = opts.minAlignCos ?? 0.6;
  const bandM = opts.bandM ?? 120;
  const minSpan = opts.minSpanM ?? 120;
  const classes =
    opts.classes ?? new Set<NetworkClass>(["buffered", "protected"]);
  const segs = loadNetwork();

  // OD axis in local meters, origin at `from`.
  const mLat = M_PER_DEG_LAT;
  const mLng = metersPerDegLng((from[1] + to[1]) / 2);
  const toLocal = (c: [number, number]): [number, number] => [
    (c[0] - from[0]) * mLng,
    (c[1] - from[1]) * mLat,
  ];
  const [tx, ty] = toLocal(to);
  const L = Math.hypot(tx, ty);
  if (L < 1) return null;
  const ux = tx / L;
  const uy = ty / L; // unit along
  const px = -uy;
  const py = ux; // unit perpendicular

  interface Hit {
    along: number;
    offset: number;
    pt: [number, number];
    cls: NetworkClass;
  }
  const hits: Hit[] = [];
  for (const s of segs) {
    if (!classes.has(s.cls)) continue;
    for (let i = 0; i < s.coords.length - 1; i++) {
      const a = s.coords[i];
      const b = s.coords[i + 1];
      const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const [mx, my] = toLocal(mid);
      const along = mx * ux + my * uy;
      if (along < -overshoot || along > L + overshoot) continue;
      const offset = mx * px + my * py;
      if (Math.abs(offset) > halfWidth) continue;
      const [ax, ay] = toLocal(a);
      const [bx, by] = toLocal(b);
      const sx = bx - ax;
      const sy = by - ay;
      const slen = Math.hypot(sx, sy) || 1;
      const cos = Math.abs((sx * ux + sy * uy) / slen);
      if (cos < minAlignCos) continue;
      hits.push({ along, offset, pt: mid, cls: s.cls });
    }
  }
  if (hits.length === 0) return null;

  // Cluster by perpendicular offset into bands; isolate one parallel facility.
  hits.sort((a, b) => a.offset - b.offset);
  const bands: Hit[][] = [];
  let cur: Hit[] = [];
  let bandStart = hits[0].offset;
  for (const h of hits) {
    if (cur.length > 0 && h.offset - bandStart > bandM) {
      bands.push(cur);
      cur = [];
      bandStart = h.offset;
    }
    cur.push(h);
  }
  if (cur.length > 0) bands.push(cur);

  // Pick the band covering the most along-corridor distance.
  let best: Hit[] | null = null;
  let bestSpan = -1;
  for (const band of bands) {
    const alongs = band.map((h) => h.along);
    const span = Math.max(...alongs) - Math.min(...alongs);
    if (span > bestSpan) {
      bestSpan = span;
      best = band;
    }
  }
  if (best === null || bestSpan < minSpan) return null;

  best.sort((a, b) => a.along - b.along);
  const classCounts: Record<string, number> = {};
  for (const h of best) classCounts[h.cls] = (classCounts[h.cls] ?? 0) + 1;
  return {
    spine: best.map((h) => h.pt),
    lengthM: Math.round(bestSpan),
    classCounts,
  };
}
