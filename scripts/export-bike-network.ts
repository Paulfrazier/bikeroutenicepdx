/**
 * export-bike-network.ts
 *
 * Produces the full "Portland bike map" overlay GeoJSON for the front-ends:
 * every ACTIVE segment of the City's official Bicycle Network, classified by
 * facility type so the map can color greenways AND bike-friendly streets.
 *
 * SOURCE 1: City of Portland "Bicycle Network" layer (PortlandMaps Open Data).
 *   https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer/75
 *   This single authoritative layer carries both Neighborhood Greenways (NG)
 *   and on-street facilities (PBL/BBL/BL/...) via its `Facility` field. It
 *   replaces the older ArcGIS "Bicycle_Network"/FacilityType layer that PBOT
 *   retired, and supersedes the greenways-only export for display purposes.
 *
 * SOURCE 2: PBOT "Recommended Bicycle Routes" layer 4 (the cartographic "Bike
 *   There!" map). https://www.portlandmaps.com/arcgis/rest/services/Public/PBOT_RecommendedBicycleRoutes/MapServer/4
 *   We pull ONLY its two shared-roadway classes via `ConnectionType`:
 *   SR_LT ("Shared Roadway, Low Traffic") and SR_MT ("…, Moderate Traffic").
 *   These are recommended quiet streets with NO built facility, so they're
 *   absent from source 1 — purely additive. Everything else in layer 4
 *   (NG/BL/BBL/MUP) we ignore because source 1 carries it with authoritative
 *   facility codes. They're why e.g. SE 16th south of Ladd Circle is a real
 *   recommended route even though it has no lane or greenway.
 *
 * WRITES: web/public/bike-network.geojson                       (web overlay)
 *         ios/BikeRouteNicePDX/Resources/bike-network.geojson    (bundled iOS)
 *         server/data/bike-network.geojson                       (server runtime)
 *
 * Each feature: { type:"Feature", geometry:LineString|MultiLineString,
 *                 properties:{ class, facility, name? } }
 *   class    — normalized display category (see CLASS_MAP/SHARED_MAP), drives color
 *   facility — raw PBOT code (PBL/BBL/BL/NG/TRL/ESR/ABL/… or SR_LT/SR_MT)
 *   name     — SegmentName / StreetName when present
 *
 * EXTERNAL DEPS: none (Node built-ins: fs, path, fetch)
 * USAGE:  npm run export:bike-network
 * EXIT CODES: 0 wrote both files · 1 fetch failed / empty result
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { bakeRenderClass, MIN_FAST_MPH, MIN_STROAD_LANES } from "./lib/render-class.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LAYER_URL =
  "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer/75";
const PAGE_SIZE = 200; // layer maxRecordCount
const WHERE = "Status='ACTIVE'";
const OUT_FIELDS = "Facility,SegmentName,SCS";

// SOURCE 2 — PBOT Recommended Bicycle Routes layer 4: pull ONLY the two
// shared-roadway classes (recommended quiet streets with no built facility).
const SHARED_LAYER_URL =
  "https://www.portlandmaps.com/arcgis/rest/services/Public/PBOT_RecommendedBicycleRoutes/MapServer/4";
const SHARED_PAGE_SIZE = 1000; // layer maxRecordCount is 2000; stay well under
const SHARED_WHERE = "ConnectionType IN ('SR_LT','SR_MT')";
const SHARED_FIELDS = "ConnectionType,StreetName";

// PBOT Facility code -> normalized display class.
// Order of color priority for the map legend: protected > buffered > greenway
// > path > lane > shared. `calm`/`calm_mod` come from source 2 (SR_LT/SR_MT).
type DisplayClass =
  | "greenway"
  | "path"
  | "protected"
  | "buffered"
  | "lane"
  | "shared"
  | "calm" // SR_LT — shared roadway, low traffic (just below greenway)
  | "calm_mod"; // SR_MT — shared roadway, moderate traffic (below buffered)

const CLASS_MAP: Record<string, DisplayClass> = {
  NG: "greenway", // Neighborhood Greenway
  TRL: "path", // Off-Street Paths/Trails
  PBL: "protected", // Protected Bike Lane
  SIR: "protected", // Separated in-Roadway
  BBL: "buffered", // Buffered Bike Lane
  BBBL: "buffered", // Buffered variants
  SBBL: "buffered",
  BL: "lane", // Bike Lane
  ABL: "lane", // Advisory Bike Lane
  ESR: "shared", // Enhanced Shared Roadway
};

// PBOT layer-4 ConnectionType -> normalized display class (shared roadways only).
const SHARED_MAP: Record<string, DisplayClass> = {
  SR_LT: "calm", // Shared Roadway, Low Traffic
  SR_MT: "calm_mod", // Shared Roadway, Moderate Traffic
};

const OUT_WEB = path.join(REPO_ROOT, "web", "public", "bike-network.geojson");
const OUT_IOS = path.join(
  REPO_ROOT,
  "ios",
  "BikeRouteNicePDX",
  "Resources",
  "bike-network.geojson"
);
// The server also needs the classified network at runtime to compute per-step
// greenway class + coverage (server/src/services/greenway-coverage.ts). It must
// live inside the server workspace so it ships in the Railway build (which only
// bundles `server`), not just in web/public.
const OUT_SERVER = path.join(REPO_ROOT, "server", "data", "bike-network.geojson");

const COORD_PRECISION = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GeoJSONFeature {
  type: "Feature";
  geometry: { type: string; coordinates: unknown } | null;
  properties: Record<string, unknown> | null;
}
interface FeatureCollection {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
  error?: unknown;
  exceededTransferLimit?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(n: number): number {
  const f = 10 ** COORD_PRECISION;
  return Math.round(n * f) / f;
}

function roundCoords(coords: unknown): unknown {
  if (Array.isArray(coords)) {
    if (typeof coords[0] === "number" && typeof coords[1] === "number") {
      return [round(coords[0] as number), round(coords[1] as number)];
    }
    return coords.map(roundCoords);
  }
  return coords;
}

/** Validate + round one source feature into our normalized shape, or null if the
 * geometry is missing/degenerate. Drop empty/degenerate geometry: a LineString
 * needs ≥2 positions and a MultiLineString needs ≥1 non-empty part — Apple's
 * MKGeoJSONDecoder throws `nilError` on the WHOLE collection if any single
 * feature has empty coordinates, which silently blanks the entire iOS overlay. */
function buildFeature(
  feature: GeoJSONFeature,
  cls: DisplayClass,
  facility: string,
  name: unknown
): GeoJSONFeature | null {
  if (!feature.geometry) return null;
  const t = feature.geometry.type;
  if (t !== "LineString" && t !== "MultiLineString") return null;
  const coords = feature.geometry.coordinates;
  const hasGeometry =
    Array.isArray(coords) &&
    (t === "LineString"
      ? coords.length >= 2
      : coords.some((part) => Array.isArray(part) && part.length >= 2));
  if (!hasGeometry) return null;
  return {
    type: "Feature",
    geometry: { type: t, coordinates: roundCoords(feature.geometry.coordinates) },
    properties: {
      class: cls,
      facility,
      ...(typeof name === "string" && name ? { name } : {}),
    },
  };
}

/** Layer 75 (Bicycle Network): classify by the `Facility` code. */
function trim(feature: GeoJSONFeature): GeoJSONFeature | null {
  const facility = String(feature.properties?.["Facility"] ?? "").trim();
  const cls = CLASS_MAP[facility];
  if (!cls) return null; // skip NONE / unrecognized
  return buildFeature(feature, cls, facility, feature.properties?.["SegmentName"]);
}

/** Layer 4 (Recommended Routes): classify by the `ConnectionType` code; we only
 * ever fetch SR_LT/SR_MT, but guard anyway so an unexpected code is skipped. */
function trimShared(feature: GeoJSONFeature): GeoJSONFeature | null {
  const code = String(feature.properties?.["ConnectionType"] ?? "").trim();
  const cls = SHARED_MAP[code];
  if (!cls) return null;
  return buildFeature(feature, cls, code, feature.properties?.["StreetName"]);
}

interface PageOpts {
  url: string;
  where: string;
  fields: string;
  pageSize: number;
  offset: number;
}

async function fetchPage(opts: PageOpts): Promise<FeatureCollection> {
  const params = new URLSearchParams({
    where: opts.where,
    outFields: opts.fields,
    outSR: "4326",
    f: "geojson",
    resultOffset: String(opts.offset),
    resultRecordCount: String(opts.pageSize),
    returnGeometry: "true",
  });
  const url = `${opts.url}/query?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ offset ${opts.offset}`);
  const fc = JSON.parse(await res.text()) as FeatureCollection;
  if (fc.error) throw new Error(`ArcGIS error: ${JSON.stringify(fc.error)}`);
  return fc;
}

/** Paginate one layer to exhaustion, trimming + classifying each feature into
 * `kept` and tallying `byClass`. Returns the raw feature count fetched. */
async function collect(
  label: string,
  cfg: Omit<PageOpts, "offset">,
  trimFn: (f: GeoJSONFeature) => GeoJSONFeature | null,
  kept: GeoJSONFeature[],
  byClass: Record<string, number>
): Promise<number> {
  let offset = 0;
  let raw = 0;
  for (;;) {
    const fc = await fetchPage({ ...cfg, offset });
    const page = fc.features ?? [];
    raw += page.length;
    for (const f of page) {
      const t = trimFn(f);
      if (t) {
        kept.push(t);
        const c = String(t.properties?.["class"]);
        byClass[c] = (byClass[c] ?? 0) + 1;
      }
    }
    process.stdout.write(`\r[${label}] offset ${offset} → ${raw} raw / ${kept.length} kept`);
    if (page.length < cfg.pageSize && !fc.exceededTransferLimit) break;
    offset += cfg.pageSize;
  }
  process.stdout.write("\n");
  return raw;
}

function writeBoth(features: GeoJSONFeature[]): void {
  const json = JSON.stringify({ type: "FeatureCollection", features });
  for (const target of [OUT_WEB, OUT_IOS, OUT_SERVER]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json, "utf8");
    console.log(
      `[OK]    wrote ${(json.length / 1024).toFixed(1)} KB → ${path.relative(REPO_ROOT, target)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`[source 1] City of Portland Bicycle Network (ACTIVE)\n           ${LAYER_URL}`);
  console.log(`[source 2] PBOT Recommended Routes — shared roadways (SR_LT/SR_MT)\n           ${SHARED_LAYER_URL}`);
  const kept: GeoJSONFeature[] = [];
  const byClass: Record<string, number> = {};

  // Source 1 — the authoritative facility inventory (greenways + on-street).
  await collect(
    "facilities",
    { url: LAYER_URL, where: WHERE, fields: OUT_FIELDS, pageSize: PAGE_SIZE },
    trim,
    kept,
    byClass
  );
  const facilityCount = kept.length;

  // Source 2 — recommended shared roadways (calm/calm_mod), additive to source 1.
  await collect(
    "shared",
    { url: SHARED_LAYER_URL, where: SHARED_WHERE, fields: SHARED_FIELDS, pageSize: SHARED_PAGE_SIZE },
    trimShared,
    kept,
    byClass
  );
  console.log(
    `[merge] ${facilityCount} facility + ${kept.length - facilityCount} shared-roadway features`
  );

  // Guard on the FACILITY count, not the total: source 2 is additive, so a
  // source-1 outage that returned 0 facilities must still abort even if the
  // shared-roadway fetch succeeded — never ship a facility-less overlay.
  if (facilityCount === 0) {
    console.error("[ERROR] no facility features produced — aborting (won't overwrite with empty set)");
    process.exit(1);
  }

  console.log("[classes]", JSON.stringify(byClass));

  // Bake the render class (rclass): down-rate unprotected lanes on fast streets
  // to "busy" by joining against the posted-speed export, so the overlay + route
  // color them red without any runtime speed lookup. Requires speeds.geojson
  // (run export:speeds first); skipped with a warning if it's missing.
  const speedsPath = path.join(REPO_ROOT, "web", "public", "speeds.geojson");
  if (fs.existsSync(speedsPath)) {
    const speeds = JSON.parse(fs.readFileSync(speedsPath, "utf8"));
    // Also down-rate plain unbuffered lanes (PBOT "lane"/BL) that run along an
    // arterial — the door-zone collector-lane case (NE 7th etc.) that the posted-
    // speed rule misses because these are tagged 20 mph. Buffered lanes are spared.
    const arterialsPath = path.join(REPO_ROOT, "web", "public", "arterials.geojson");
    const arterials = fs.existsSync(arterialsPath)
      ? JSON.parse(fs.readFileSync(arterialsPath, "utf8"))
      : undefined;
    if (!arterials) {
      console.warn(
        `[rclass] WARN: ${path.relative(REPO_ROOT, arterialsPath)} not found — run export:arterials. Skipping the door-zone-lane-on-arterial down-rate.`
      );
    }
    const { busy, caution2, caution3, caution4 } = bakeRenderClass(kept, speeds, MIN_FAST_MPH, arterials);
    console.log(
      `[rclass] ${busy} on ≥${MIN_FAST_MPH} mph → "busy"; arterial-lane gradient → caution2 ${caution2} (≤2 lanes) · caution3 ${caution3} (3) · caution4 ${caution4} (≥${MIN_STROAD_LANES})`
    );
  } else {
    console.warn(
      `[rclass] WARN: ${path.relative(REPO_ROOT, speedsPath)} not found — run export:speeds, then bake:render-class. Writing without downgrade.`
    );
    for (const f of kept) if (f.properties) f.properties["rclass"] = f.properties["class"];
  }

  writeBoth(kept);
  console.log(`\nDone — ${kept.length} bike-network features.`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
