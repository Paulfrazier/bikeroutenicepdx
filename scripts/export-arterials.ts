/**
 * export-arterials.ts
 *
 * Produces a compact "arterials" overlay GeoJSON: Portland's bigger/faster
 * roads (motorway/trunk/primary/secondary/tertiary). The bike-friendliness
 * classifier uses it to tell a CALM neighborhood street (no bike facility, but
 * also not a busy road → comfortable) apart from a genuinely hostile arterial
 * (no bike facility AND a big road → warn). Without this, every off-network
 * segment is flagged red, which over-warns on quiet streets.
 *
 * POSTED SPEED BAKE: OSM's `highway` class alone over-warns — `tertiary` is a low
 * bar that OSM hands to many calm neighborhood collectors (e.g. NE 74th Ave,
 * posted 20 mph). So we also stamp each arterial with the CITY's posted speed
 * (PortlandMaps layer 225) via a normalized-name + proximity join, and the
 * classifier vetoes the red "busy" treatment on a street the city posts as calm.
 * We store the MAX posted speed found along a feature, so a way that touches any
 * fast section is never mistaken for calm (a missed match just leaves it red —
 * conservative; it can never under-flag a genuinely fast road).
 *
 * SOURCES:
 *   - OpenStreetMap via Overpass (no key, ODbL) — the arterial geometry + class.
 *   - PortlandMaps Open Data layer 225 "Speed Limits" — posted mph per segment.
 *
 * WRITES: web/public/arterials.geojson                       (web overlay)
 *         ios/BikeRouteNicePDX/Resources/arterials.geojson    (bundled iOS)
 *
 * Each feature: { type:"Feature", geometry:LineString,
 *                 properties:{ class, name?, mph?, lanes? } }
 *   class — OSM highway value: motorway|trunk|primary|secondary|tertiary
 *   name  — OSM street name (when tagged); lets the friendliness classifier
 *           apply the user's personal per-street ratings to a bare arterial.
 *   mph   — max city-posted speed found along the way (when name+geometry matched
 *           a PortlandMaps speed segment); omitted when unmatched.
 *   lanes — OSM `lanes` count (total, both directions incl. turn lanes) when the
 *           way carries a numeric tag; omitted otherwise. The render-class bake
 *           reads it to down-rate an unprotected bike lane on a 4+ lane stroad
 *           (e.g. Foster/Powell/Holgate, posted 30–35 so the speed rule misses
 *           them) to "caution" — see scripts/lib/render-class.ts (MIN_STROAD_LANES).
 *
 * Coordinates are rounded to 5 decimals (~1 m) to keep the file small.
 *
 * EXTERNAL DEPS: none (Node built-ins: fs, path, fetch)
 * USAGE:  npm run export:arterials
 * EXIT CODES: 0 wrote both files · 1 fetch failed / empty result
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { normalizeStreetName } from "../web/src/streetRatings.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/** Portland metro bbox: south, west, north, east (Overpass order). */
const BBOX = "45.45,-122.78,45.62,-122.55";

/** Arterial highway classes (excludes *_link ramps). */
const ARTERIAL_CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary"];

const QUERY = `[out:json][timeout:90];
way["highway"~"^(${ARTERIAL_CLASSES.join("|")})$"]["highway"!~"link"](${BBOX});
out geom;`;

const COORD_PRECISION = 5;

// PortlandMaps posted-speed layer (same source export-speeds.ts uses for ≥30).
const SPEED_LAYER_URL =
  "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer/225";
const SPEED_PAGE_SIZE = 200; // service maxRecordCount

// Speed-join match tolerance. Generous on distance (OSM and PBOT centerlines for
// the same street can sit a few metres apart) but gated by NORMALIZED NAME, so a
// loose radius still can't pick up a different street or a perpendicular cross
// street (also bearing-aligned). Grid cell matches the runtime classifier.
const CELL = 0.0003;
const JOIN_THRESHOLD_M = 30;
const JOIN_BEARING_TOL_DEG = 40;

const OUT_PATHS = [
  path.join(REPO_ROOT, "web", "public", "arterials.geojson"),
  path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources", "arterials.geojson"),
];

// ---------------------------------------------------------------------------
// Geometry helpers (equirectangular, mirrors web/src/friendliness.ts)
// ---------------------------------------------------------------------------

type LngLat = [number, number];
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const M_PER_DEG_LNG = 111320;
const M_PER_DEG_LAT = 110540;

const round = (n: number) => Number(n.toFixed(COORD_PRECISION));

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

// ---------------------------------------------------------------------------
// Speed index: posted-speed segments keyed by spatial grid cell
// ---------------------------------------------------------------------------

interface SpeedSeg {
  a: LngLat;
  b: LngLat;
  bearing: number;
  mph: number;
  /** Normalized street name — the join key. */
  name: string;
}
type SpeedGrid = Map<string, SpeedSeg[]>;

function addSpeedSeg(grid: SpeedGrid, seg: SpeedSeg): void {
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

function indexSpeedLine(grid: SpeedGrid, line: LngLat[], mph: number, name: string): void {
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    addSpeedSeg(grid, { a, b, bearing: bearing(a, b), mph, name });
  }
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: {
    geometry: { type: string; coordinates: unknown } | null;
    properties: Record<string, unknown> | null;
  }[];
  error?: unknown;
  exceededTransferLimit?: boolean;
}

async function fetchSpeedPage(offset: number): Promise<FeatureCollection> {
  const params = new URLSearchParams({
    where: "1=1",
    outFields: "SpeedLimit,RoadName",
    outSR: "4326",
    f: "geojson",
    // Clip to the app bbox to skip the city's far edges.
    geometry: JSON.stringify({
      xmin: -122.78, ymin: 45.45, xmax: -122.55, ymax: 45.62,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryEnvelope",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    resultOffset: String(offset),
    resultRecordCount: String(SPEED_PAGE_SIZE),
    returnGeometry: "true",
  });
  const url = `${SPEED_LAYER_URL}/query?${params.toString()}`;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "BikeRouteNicePDX/1.0 (arterials speed join)",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ offset ${offset}`);
      const fc = JSON.parse(await res.text()) as FeatureCollection;
      if (fc.error) throw new Error(`ArcGIS error: ${JSON.stringify(fc.error)}`);
      return fc;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Page the whole posted-speed layer (within bbox) into a name+spatial index. */
async function buildSpeedGrid(): Promise<SpeedGrid> {
  console.log(`[speeds] indexing PortlandMaps posted speeds for the join`);
  const grid: SpeedGrid = new Map();
  let offset = 0;
  let raw = 0;
  let indexed = 0;
  for (;;) {
    const fc = await fetchSpeedPage(offset);
    const page = fc.features ?? [];
    raw += page.length;
    for (const f of page) {
      const geom = f.geometry;
      if (!geom) continue;
      const mph = Number(String(f.properties?.["SpeedLimit"] ?? "").trim());
      if (!Number.isFinite(mph) || mph <= 0) continue;
      const rawName = f.properties?.["RoadName"];
      const name = typeof rawName === "string" ? normalizeStreetName(rawName) : "";
      if (!name) continue; // join is name-gated; unnamed speed segs are unusable
      if (geom.type === "LineString") {
        indexSpeedLine(grid, geom.coordinates as LngLat[], mph, name);
        indexed++;
      } else if (geom.type === "MultiLineString") {
        for (const line of geom.coordinates as LngLat[][]) indexSpeedLine(grid, line, mph, name);
        indexed++;
      }
    }
    process.stdout.write(`\r[speeds] offset ${offset} → ${raw} raw / ${indexed} indexed`);
    if (page.length < SPEED_PAGE_SIZE && !fc.exceededTransferLimit) break;
    offset += SPEED_PAGE_SIZE;
  }
  process.stdout.write("\n");
  return grid;
}

/**
 * Max city-posted speed found along an arterial way, via normalized-name +
 * proximity match. Returns null when nothing same-named is close (→ no veto;
 * the street keeps whatever the OSM-class heuristic decides).
 */
function postedSpeedFor(coords: LngLat[], normName: string, grid: SpeedGrid): number | null {
  if (!normName) return null;
  let best: number | null = null;
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const M: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const segBearing = bearing(a, b);
    const cellLat = Math.floor(M[1] / CELL);
    const cellLng = Math.floor(M[0] / CELL);
    let bestDist = JOIN_THRESHOLD_M;
    let matchMph: number | null = null;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const bucket = grid.get(`${cellLat + dy},${cellLng + dx}`);
        if (!bucket) continue;
        for (const seg of bucket) {
          if (seg.name !== normName) continue;
          if (bearingDiff(segBearing, seg.bearing) > JOIN_BEARING_TOL_DEG) continue;
          const d = perpDistanceM(M, seg.a, seg.b);
          if (d <= bestDist) {
            bestDist = d;
            matchMph = seg.mph;
          }
        }
      }
    }
    if (matchMph !== null && (best === null || matchMph > best)) best = matchMph;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Overpass arterials
// ---------------------------------------------------------------------------

interface OverpassWay {
  type: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
interface OverpassResponse {
  elements: OverpassWay[];
}

async function fetchArterials(): Promise<OverpassWay[]> {
  console.log(`[overpass] fetching arterials for bbox ${BBOX}`);
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "BikeRouteNicePDX/1.0 (arterials export)",
      Accept: "application/json",
    },
    body: "data=" + encodeURIComponent(QUERY),
  });
  if (!res.ok) {
    console.error(`[ERROR] Overpass HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = (await res.json()) as OverpassResponse;
  return data.elements ?? [];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [elements, speedGrid] = await Promise.all([fetchArterials(), buildSpeedGrid()]);

  const features: GeoJSON.Feature[] = [];
  const counts: Record<string, number> = {};
  let matched = 0;
  let calm = 0;
  let wide = 0;
  for (const el of elements) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const cls = el.tags?.highway;
    if (!cls || !ARTERIAL_CLASSES.includes(cls)) continue;

    // Round + drop consecutive duplicate points produced by rounding.
    const coords: LngLat[] = [];
    for (const p of el.geometry) {
      const c: LngLat = [round(p.lon), round(p.lat)];
      const last = coords[coords.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
    }
    if (coords.length < 2) continue;

    const name = el.tags?.name?.trim();
    const properties: Record<string, string | number> = { class: cls };
    if (name) properties.name = name;

    // OSM `lanes` (total, both directions). Lets the render-class bake spot a
    // multi-lane stroad whose unprotected bike lane is stressful regardless of
    // posted speed. Omitted when untagged or non-numeric.
    const lanes = Number(el.tags?.lanes);
    if (Number.isFinite(lanes) && lanes >= 1) {
      properties.lanes = lanes;
      if (lanes >= 4) wide++;
    }

    // Stamp the city's max posted speed along this way (name+proximity join).
    const mph = name ? postedSpeedFor(coords, normalizeStreetName(name), speedGrid) : null;
    if (mph !== null) {
      properties.mph = mph;
      matched++;
      if (mph <= 25) calm++;
    }

    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates: coords },
      properties,
    });
    counts[cls] = (counts[cls] ?? 0) + 1;
  }

  if (features.length === 0) {
    console.error("[ERROR] no arterial features returned — aborting (won't write empty files)");
    process.exit(1);
  }

  const fc: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
  const json = JSON.stringify(fc);
  for (const out of OUT_PATHS) {
    fs.writeFileSync(out, json);
    console.log(`[OK] ${path.relative(REPO_ROOT, out)} — ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(
    `[done] ${features.length} arterials`,
    counts,
    `· speed-matched ${matched} (${calm} calm ≤25mph) · ${wide} ways ≥4 lanes`
  );
}

main().catch((err) => {
  console.error("[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
