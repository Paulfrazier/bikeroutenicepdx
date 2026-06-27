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
import { normalizeStreetName, overrides } from "./streetRatings";
import { listConnectors, getVersion as connectorsVersion } from "./connectors";
import type { LngLat, ManualSegment } from "./types";

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
/** A no-facility segment on an arterial the CITY posts at or below this speed is
 * NOT down-rated to "busy" — OSM's highway class (often `tertiary` on calm
 * collectors) can't override the city's posted speed. Hazard streets (≥30 mph or
 * bicycle high-crash) still win. (KEEP IN SYNC WITH iOS.) */
const CALM_MAX_MPH = 25;
/** Widened facility-match radius (m) used ONLY to rescue a would-be-"busy"
 * segment when a bike facility ON THE SAME STREET sits just past THRESHOLD_M
 * (PBOT facility geometry is often offset ~20–35 m from the road centerline, so a
 * real buffered/protected lane gets missed and the street is wrongly painted red).
 * Name-gated, so a larger radius only catches MORE same-street offsets — it can
 * never adopt a different street's facility. (KEEP IN SYNC WITH iOS.) */
const FACILITY_RESCUE_M = 35;

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
// Equirectangular meters-per-degree factors (per algorithm spec).
const M_PER_DEG_LNG = 111320; // scaled by cos(lat) at use-site
const M_PER_DEG_LAT = 110540;

/**
 * A route segment's category: one of the bike-network facility classes (so the
 * route matches the bike-map legend exactly), the baked "caution2/3/4" down-rate
 * gradient (a painted lane on an arterial, darker as the road widens), plus two
 * off-network states —
 * "quiet" (calm neighborhood street) and "busy" (the red dashed danger signal).
 */
export type RouteClass =
  | "protected"
  | "greenway"
  | "path"
  | "buffered"
  | "lane"
  | "caution2"
  | "caution3"
  | "caution4"
  | "shared"
  | "quiet"
  | "busy";

/**
 * Route-class → render color. The facility colors are IDENTICAL to the
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
  caution2: "#FB923C",
  caution3: "#EA580C",
  caution4: "#9A3412",
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

/** Normalize a bike-network render class (`rclass`, falling back to `class`) to a
 * known RouteClass. "busy" and "caution2/3/4" are valid baked values — an
 * unprotected lane the export down-rated (busy = on a ≥40 mph street; caution2/3/4
 * = a painted lane on an arterial, graded by lane count; see
 * scripts/lib/render-class.ts) — so the overlay and the route draw them without
 * any runtime speed lookup. */
function normalizeClass(cls: string): RouteClass {
  switch (cls) {
    case "protected":
    case "greenway":
    case "path":
    case "buffered":
    case "lane":
    case "caution2":
    case "caution3":
    case "caution4":
    case "shared":
    case "busy":
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
  /** Normalized street name (for personal-rating override), or null. */
  name: string | null;
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
function indexLineString(
  grid: Grid,
  coords: LngLat[],
  cls: RouteClass,
  name: string | null
): void {
  if (coords.length < 2) return;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    addToGrid(grid, { a, b, cls, bearing: bearing(a, b), name });
  }
}

async function buildIndex(url: string): Promise<Grid> {
  const grid: Grid = new Map();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`bike-network fetch failed: ${res.status}`);
  const fc = (await res.json()) as GeoJSON.FeatureCollection;
  for (const feat of fc.features ?? []) {
    // Prefer the baked render class (rclass) — it already down-rates unprotected
    // lanes on fast streets to "busy" — falling back to the raw facility class.
    const cls = normalizeClass(
      ((feat.properties?.rclass ?? feat.properties?.class) as string | undefined) ?? "shared"
    );
    const rawName = feat.properties?.name as string | undefined;
    const name = rawName ? normalizeStreetName(rawName) : null;
    const geom = feat.geometry;
    if (!geom) continue;
    if (geom.type === "LineString") {
      indexLineString(grid, geom.coordinates as LngLat[], cls, name);
    } else if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates) {
        indexLineString(grid, line as LngLat[], cls, name);
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

// ── Connector index (personal + community map-fixes) ─────────────────────────
// User-drawn "connectors" patch gaps the routing data misses (a mislabeled
// cycletrack, an invisible crossing, a cut-through). Two sources feed one index:
//   - PERSONAL connectors live in connectors.ts (localStorage, this device).
//   - COMMUNITY connectors ship bundled as /community-fixes.geojson (validated).
// Every connector is treated as a comfortable `path` facility: it classifies as
// "path" (a STRONG facility, never hazard-down-rated) and — via
// connectorSegmentsForRoute — is spliced into any route that passes near BOTH of
// its ends. KEEP IN SYNC WITH iOS (BikeFriendliness / Connectors).

/** The facility class every connector is treated as. */
const CONNECTOR_CLASS: RouteClass = "path";

// Community connector polylines, fetched + cached once for the page lifetime.
let communityLines: LngLat[][] = [];
let communityPromise: Promise<void> | null = null;

/** Parse /community-fixes.geojson into a flat list of polylines (best-effort). */
async function loadCommunityFixes(url: string): Promise<void> {
  try {
    const res = await fetch(url);
    if (!res.ok) return; // community fixes are optional — leave the list empty
    const fc = (await res.json()) as GeoJSON.FeatureCollection;
    const lines: LngLat[][] = [];
    for (const feat of fc.features ?? []) {
      const geom = feat.geometry;
      if (!geom) continue;
      if (geom.type === "LineString") {
        lines.push(geom.coordinates as LngLat[]);
      } else if (geom.type === "MultiLineString") {
        for (const line of geom.coordinates) lines.push(line as LngLat[]);
      }
    }
    communityLines = lines;
  } catch {
    /* network/parse error — leave the community list empty */
  }
}

// The connector grid is rebuilt whenever personal connectors change (cheap —
// there are only a handful) so a freshly drawn fix recolors + re-splices at once.
let connectorGrid: Grid | null = null;
let connectorGridVersion = -1;

/** Build a spatial grid over every connector (community + personal) as `path`. */
function buildConnectorGrid(): Grid {
  const grid: Grid = new Map();
  for (const line of communityLines) {
    indexLineString(grid, line, CONNECTOR_CLASS, null);
  }
  for (const c of listConnectors()) {
    indexLineString(grid, c.coords, CONNECTOR_CLASS, null);
  }
  return grid;
}

/** Connector grid, rebuilt lazily when the personal-connector version changes. */
function getConnectorGrid(): Grid {
  const v = connectorsVersion();
  if (!connectorGrid || connectorGridVersion !== v) {
    connectorGrid = buildConnectorGrid();
    connectorGridVersion = v;
  }
  return connectorGrid;
}

/**
 * Fetch the community fixes once, then return the current connector grid
 * (community + personal). Awaited by classifyRoute alongside the other indexes.
 */
export function loadConnectorIndex(
  url = "/community-fixes.geojson"
): Promise<Grid> {
  if (!communityPromise) communityPromise = loadCommunityFixes(url);
  return communityPromise.then(() => getConnectorGrid());
}

/** Whether a route-segment midpoint runs on/along a connector (→ "path"). */
function isOnConnector(
  M: LngLat,
  routeBearing: number,
  grid: Grid
): boolean {
  const cellLat = Math.floor(M[1] / CELL);
  const cellLng = Math.floor(M[0] / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        if (bearingDiff(routeBearing, seg.bearing) > BEARING_TOL_DEG) continue;
        if (perpDistanceM(M, seg.a, seg.b) <= THRESHOLD_M) return true;
      }
    }
  }
  return false;
}

/** Minimum distance (m) from a point to any segment of a polyline. */
function minDistanceToPolylineM(p: LngLat, coords: LngLat[]): number {
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const pt = closestPointOnSegmentMeters(p, coords[i], coords[i + 1]);
    const d = haversineLength([p, pt]);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Connectors (community + personal) whose BOTH endpoints lie within `maxMeters`
 * of the route — the ones to splice into it. Returned as ManualSegment-shaped
 * objects so the caller can fold them into applyManualSegments() exactly like a
 * hand-drawn stretch. Community connectors load asynchronously; until then only
 * personal connectors (available synchronously from localStorage) are returned.
 */
export function connectorSegmentsForRoute(
  routeCoords: LngLat[],
  maxMeters = 30
): ManualSegment[] {
  if (routeCoords.length < 2) return [];
  const candidates: ManualSegment[] = [
    ...communityLines.map((coords, i) => ({ id: `community-${i}`, coords })),
    ...listConnectors().map((c) => ({ id: c.id, coords: c.coords })),
  ];
  const out: ManualSegment[] = [];
  for (const c of candidates) {
    if (c.coords.length < 2) continue;
    const head = c.coords[0];
    const tail = c.coords[c.coords.length - 1];
    if (
      minDistanceToPolylineM(head, routeCoords) <= maxMeters &&
      minDistanceToPolylineM(tail, routeCoords) <= maxMeters
    ) {
      out.push(c);
    }
  }
  return out;
}

// ── Arterial spatial index ──────────────────────────────────────────────────
// A second, lighter index over Portland's busy roads (motorway…tertiary). When
// a route segment matches no bike facility, proximity to an arterial decides
// red ("mixed with fast traffic") vs calm (quiet neighborhood street).

interface ArtSegment {
  a: LngLat;
  b: LngLat;
  bearing: number;
  /** Normalized street name (for personal-rating override), or null. */
  name: string | null;
  /** Max city-posted speed (mph) baked onto this arterial, or null when the
   * speed join found no match. Drives the calm-street veto. Unused (null) for
   * hazard-index segments. */
  mph: number | null;
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

function indexArtLineString(
  grid: ArtGrid,
  coords: LngLat[],
  name: string | null,
  mph: number | null = null
): void {
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    addArtToGrid(grid, { a, b, bearing: bearing(a, b), name, mph });
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
    const rawName = feat.properties?.name as string | undefined;
    const name = rawName ? normalizeStreetName(rawName) : null;
    const rawMph = feat.properties?.mph;
    const mph = typeof rawMph === "number" ? rawMph : null;
    if (geom.type === "LineString") {
      indexArtLineString(grid, geom.coordinates as LngLat[], name, mph);
    } else if (geom.type === "MultiLineString") {
      for (const line of geom.coordinates) indexArtLineString(grid, line as LngLat[], name, mph);
    }
  }
  return grid;
}

let artIndexPromise: Promise<ArtGrid> | null = null;
let resolvedArtGrid: ArtGrid | null = null;

/** Fetch + index the arterial network once; cached for the page lifetime. */
export function loadArterialIndex(
  url = "/arterials.geojson"
): Promise<ArtGrid> {
  if (!artIndexPromise) {
    artIndexPromise = buildArterialIndex(url).then((grid) => {
      resolvedArtGrid = grid;
      return grid;
    });
  }
  return artIndexPromise;
}

/**
 * Nearest NAMED street to `target` (normalized name), for tap-to-rate. Searches
 * the bike network first (named facilities), then named arterials, within
 * `maxMeters`. Returns the normalized name — the same global key the rating store
 * uses — or null when nothing named is close. Loads the indexes on first call
 * (returns null that time; warms the cache).
 */
export function nearestStreetName(
  target: LngLat,
  maxMeters = 25
): string | null {
  void loadNetworkIndex();
  void loadArterialIndex();
  const cellLat = Math.floor(target[1] / CELL);
  const cellLng = Math.floor(target[0] / CELL);
  const reach = Math.max(1, Math.ceil(maxMeters / (CELL * M_PER_DEG_LAT)));

  let bestDist = maxMeters;
  let bestName: string | null = null;
  const consider = (
    a: LngLat,
    b: LngLat,
    name: string | null
  ): void => {
    if (!name) return;
    const d = perpDistanceM(target, a, b);
    if (d < bestDist) {
      bestDist = d;
      bestName = name;
    }
  };

  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const key = `${cellLat + dy},${cellLng + dx}`;
      const bikeBucket = resolvedGrid?.get(key);
      if (bikeBucket) for (const s of bikeBucket) consider(s.a, s.b, s.name);
      const artBucket = resolvedArtGrid?.get(key);
      if (artBucket) for (const s of artBucket) consider(s.a, s.b, s.name);
    }
  }
  return bestName;
}

/**
 * If a route-segment midpoint sits on/along a busy arterial, return the nearest
 * matching arterial's name (or null when the arterial is unnamed) so the caller
 * can both flag it "busy" AND apply a personal rating to a named arterial.
 * Returns null when no arterial matches (→ a quiet street).
 */
function matchArterial(
  M: LngLat,
  routeBearing: number,
  artGrid: ArtGrid
): { name: string | null; mph: number | null } | null {
  const cellLat = Math.floor(M[1] / CELL);
  const cellLng = Math.floor(M[0] / CELL);
  let best: { name: string | null; mph: number | null } | null = null;
  let bestDist = ARTERIAL_THRESHOLD_M;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = artGrid.get(`${cellLat + dy},${cellLng + dx}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        if (bearingDiff(routeBearing, seg.bearing) > ARTERIAL_BEARING_TOL_DEG) continue;
        const d = perpDistanceM(M, seg.a, seg.b);
        if (d <= bestDist) {
          bestDist = d;
          best = { name: seg.name, mph: seg.mph };
        }
      }
    }
  }
  return best;
}

// ── Hazard index (fast streets + bicycle high-crash corridors) ───────────────
// A third index, the UNION of speeds.geojson (posted ≥30 mph) and
// high-crash.geojson (PBOT bicycle high-crash network). A route segment on a
// hazard street is down-rated to "busy" UNLESS it has separated infrastructure
// (protected/greenway/path) — those stay safe — or the user has personally rated
// it. Uses the arterial threshold/bearing constants (same "on/along a street"
// semantics), so no new parity constants are introduced.

async function buildHazardIndex(urls: string[]): Promise<ArtGrid> {
  const grid: ArtGrid = new Map();
  for (const url of urls) {
    let fc: GeoJSON.FeatureCollection;
    try {
      const res = await fetch(url);
      if (!res.ok) continue; // hazard overlays are optional — skip if absent
      fc = (await res.json()) as GeoJSON.FeatureCollection;
    } catch {
      continue;
    }
    for (const feat of fc.features ?? []) {
      const geom = feat.geometry;
      if (!geom) continue;
      if (geom.type === "LineString") {
        indexArtLineString(grid, geom.coordinates as LngLat[], null);
      } else if (geom.type === "MultiLineString") {
        for (const line of geom.coordinates) indexArtLineString(grid, line as LngLat[], null);
      }
    }
  }
  return grid;
}

let hazardIndexPromise: Promise<ArtGrid> | null = null;

/** Fetch + index the hazard overlays once; cached for the page lifetime. */
export function loadHazardIndex(
  urls = ["/speeds.geojson", "/high-crash.geojson"]
): Promise<ArtGrid> {
  if (!hazardIndexPromise) hazardIndexPromise = buildHazardIndex(urls);
  return hazardIndexPromise;
}

/** Whether a route-segment midpoint sits on/along a hazard (fast/high-crash) street. */
function isOnHazard(M: LngLat, routeBearing: number, hazardGrid: ArtGrid): boolean {
  const cellLat = Math.floor(M[1] / CELL);
  const cellLng = Math.floor(M[0] / CELL);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = hazardGrid.get(`${cellLat + dy},${cellLng + dx}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        if (bearingDiff(routeBearing, seg.bearing) > ARTERIAL_BEARING_TOL_DEG) continue;
        if (perpDistanceM(M, seg.a, seg.b) <= ARTERIAL_THRESHOLD_M) return true;
      }
    }
  }
  return false;
}

/**
 * Facility classes with physical separation/calming — a hazard street does NOT
 * down-rate these (a protected lane on a fast road is still protected). KEEP IN
 * SYNC WITH iOS (BikeFriendliness.isStrongFacility).
 */
const STRONG_FACILITY: ReadonlySet<RouteClass> = new Set<RouteClass>([
  "protected",
  "greenway",
  "path",
]);

/**
 * Rescue a would-be-"busy" segment: find a bike facility ON THE SAME STREET
 * (matched arterial name) within FACILITY_RESCUE_M — wider than THRESHOLD_M — and
 * return its class to adopt. PBOT facility geometry is often offset ~20–25 m from
 * the road centerline, so a real buffered/protected lane is missed by the normal
 * match and the street is wrongly reddened; this recovers it. Name-gated +
 * bearing-aligned, so it can never adopt a *different* street's facility. Returns
 * null when no same-named facility is close. KEEP IN SYNC WITH iOS.
 */
function rescueFacility(
  M: LngLat,
  routeBearing: number,
  grid: Grid,
  name: string
): RouteClass | null {
  const cellLat = Math.floor(M[1] / CELL);
  const cellLng = Math.floor(M[0] / CELL);
  // The rescue radius can exceed one grid cell (~33 m), so widen the cell scan to
  // cover it (mirrors nearestStreetName's reach calc).
  const reach = Math.max(1, Math.ceil(FACILITY_RESCUE_M / (CELL * M_PER_DEG_LAT)));
  let bestDist = FACILITY_RESCUE_M;
  let bestClass: RouteClass | null = null;
  let strongDist = FACILITY_RESCUE_M;
  let strongClass: RouteClass | null = null;
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
      if (!bucket) continue;
      for (const seg of bucket) {
        if (seg.name !== name) continue;
        if (bearingDiff(routeBearing, seg.bearing) > BEARING_TOL_DEG) continue;
        const d = perpDistanceM(M, seg.a, seg.b);
        if (d < bestDist) {
          bestDist = d;
          bestClass = seg.cls;
        }
        if (STRONG_FACILITY.has(seg.cls) && d < strongDist) {
          strongDist = d;
          strongClass = seg.cls;
        }
      }
    }
  }
  // Prefer a separated facility on the corridor (mirrors the main adopt rule).
  if (strongClass && strongDist <= bestDist + 2) return strongClass;
  return bestClass;
}

// ── Classification ──────────────────────────────────────────────────────────

/**
 * Classify each route segment. First try to match a nearby bike facility and
 * adopt its class (so the route matches the bike-map legend). If none matches,
 * fall back to the arterial index: on/along a busy road → "busy" (danger),
 * otherwise a quiet neighborhood street → "quiet". A personal rating on the
 * matched street always wins; otherwise a hazard street (fast / high-crash)
 * down-rates a weak or absent facility to "busy".
 */
function rawClasses(
  coords: LngLat[],
  grid: Grid,
  connectorGrid: Grid,
  artGrid: ArtGrid,
  hazardGrid: ArtGrid,
  ov: Map<string, RouteClass>
): RouteClass[] {
  const n = coords.length - 1;
  const classes: RouteClass[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const M: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const routeBearing = bearing(a, b);
    const cellLat = Math.floor(M[1] / CELL);
    const cellLng = Math.floor(M[0] / CELL);

    // A connector (user/community map-fix) wins outright — it's the explicit
    // assertion that this stretch is a comfortable path the data missed.
    if (isOnConnector(M, routeBearing, connectorGrid)) {
      classes[i] = CONNECTOR_CLASS;
      continue;
    }

    let bestDist = THRESHOLD_M;
    let bestClass: RouteClass | null = null;
    let bestName: string | null = null;
    // Track the nearest STRONG (separated) facility too: where a protected/
    // greenway/path facility coincides with a weaker one (the data maps both on
    // a corridor), the separated infra wins — and must NOT be hazard-down-rated.
    let strongDist = THRESHOLD_M;
    let strongClass: RouteClass | null = null;

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
            bestName = seg.name;
          }
          if (STRONG_FACILITY.has(seg.cls) && d < strongDist) {
            strongDist = d;
            strongClass = seg.cls;
          }
        }
      }
    }
    if (bestClass) {
      // A personal rating on the matched street always overrides the data class.
      const o = bestName ? ov.get(bestName) : undefined;
      if (o) {
        classes[i] = o;
      } else if (STRONG_FACILITY.has(bestClass)) {
        // Separated/calm infrastructure stays safe regardless of the road.
        classes[i] = bestClass;
      } else if (strongClass && strongDist <= bestDist + 2) {
        // A separated facility coincides with this weaker match → trust it.
        classes[i] = strongClass;
      } else {
        // Weak facility (lane/buffered/shared). The speed down-rate is already
        // baked into the feature's rclass (an unprotected lane on a ≥40 mph
        // street arrives here as "busy"), so adopt it directly — no runtime
        // hazard lookup, which keeps the route identical to the map overlay.
        classes[i] = bestClass;
      }
    } else {
      // No bike facility. Precedence: a personal rating on the named arterial
      // wins; then a genuine hazard (≥30 mph or bicycle high-crash) → busy; then
      // a street the CITY posts as calm (≤CALM_MAX_MPH) → quiet, even if OSM
      // classes it an arterial (`tertiary` over-warns on calm collectors); then
      // an arterial of unknown/fast posted speed → busy; otherwise quiet.
      const art = matchArterial(M, routeBearing, artGrid);
      const o = art?.name ? ov.get(art.name) : undefined;
      const rescued = art?.name ? rescueFacility(M, routeBearing, grid, art.name) : null;
      if (o) {
        classes[i] = o;
      } else if (rescued) {
        // A bike facility on THIS street sits just past THRESHOLD_M (offset PBOT
        // geometry) — adopt it instead of reddening a street that has a lane.
        classes[i] = rescued;
      } else if (isOnHazard(M, routeBearing, hazardGrid)) {
        classes[i] = "busy";
      } else if (art && art.mph !== null && art.mph <= CALM_MAX_MPH) {
        classes[i] = "quiet";
      } else if (art) {
        classes[i] = "busy";
      } else {
        classes[i] = "quiet";
      }
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
  const [grid, connectorGrid, artGrid, hazardGrid] = await Promise.all([
    loadNetworkIndex(),
    loadConnectorIndex(),
    loadArterialIndex(),
    loadHazardIndex(),
  ]);
  // Snapshot the user's personal street ratings for this classification pass.
  const ov = overrides();
  const classes = smoothClasses(
    coords,
    rawClasses(coords, grid, connectorGrid, artGrid, hazardGrid, ov)
  );

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
