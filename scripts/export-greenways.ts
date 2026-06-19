/**
 * export-greenways.ts
 *
 * Produces a trimmed greenways overlay GeoJSON for the front-ends to display.
 * Strips properties down to { class, name }, and rounds coordinates to 6
 * decimals to keep the file small enough to bundle into the iOS app.
 *
 * SOURCE (in priority order):
 *   1. If data/pbot/current/bicycle-network.geojson exists (full PBOT network
 *      produced by the routing pipeline), filter it by FacilityType to the
 *      "nice" classes (greenway / protected / off-street).
 *   2. Otherwise fetch PBOT's authoritative Neighborhood Greenways layer live
 *      from ArcGIS. This is the layer that actually exists today and is exactly
 *      the greenway lines we highlight.
 *
 * WRITES: web/public/greenways.geojson                       (web app overlay)
 *         ios/BikeRouteNicePDX/Resources/greenways.geojson    (bundled iOS overlay)
 *
 * Writing both targets from one script keeps web + iOS in sync.
 *
 * EXTERNAL DEPS: none (Node built-ins: fs, path, fetch)
 *
 * USAGE:  npm run export:greenways
 *
 * EXIT CODES:
 *   0  wrote both files
 *   1  fetch failed and no local input available
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// PBOT Neighborhood Greenways — authoritative, hosted on the City's ArcGIS org.
// (The full "Bicycle Network" layer used by the routing pipeline lives elsewhere
// and may need its URL refreshed; this overlay only needs greenway lines.)
const GREENWAYS_ARCGIS_URL =
  "https://services.arcgis.com/quVN97tn06YNGj9s/arcgis/rest/services/Neighborhood_Greenways/FeatureServer/1";
const GREENWAYS_QUERY =
  "/query?where=Status%3D%27ACTIVE%27&outFields=SegmentName&outSR=4326&f=geojson";

// FacilityType normalisation — mirrors scripts/build-graph.ts so that, if the
// full PBOT bike network is present locally, classification stays consistent.
const PBOT_CLASS_FIELD = "FacilityType";
type NormalizedClass = "off_street" | "greenway" | "protected" | "buffered" | "standard";
const CLASS_MAP: Record<string, NormalizedClass> = {
  "neighborhood greenway": "greenway",
  "protected bike lane": "protected",
  "buffered bike lane": "buffered",
  "bike lane": "standard",
  "shared roadway": "standard",
  "off-street path": "off_street",
  "multi-use path": "off_street",
  "shared use path": "off_street",
  trail: "off_street",
  path: "off_street",
};
const KEEP_CLASSES = new Set<NormalizedClass>(["greenway", "protected", "off_street"]);

const LOCAL_INPUT = path.join(REPO_ROOT, "data", "pbot", "current", "bicycle-network.geojson");
const OUT_WEB = path.join(REPO_ROOT, "web", "public", "greenways.geojson");
const OUT_IOS = path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources", "greenways.geojson");

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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeClass(raw: unknown): NormalizedClass {
  if (typeof raw !== "string") return "standard";
  return CLASS_MAP[raw.trim().toLowerCase()] ?? "standard";
}

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

function trim(feature: GeoJSONFeature, cls: string, name: unknown): GeoJSONFeature | null {
  if (!feature.geometry) return null;
  const t = feature.geometry.type;
  if (t !== "LineString" && t !== "MultiLineString") return null;
  return {
    type: "Feature",
    geometry: { type: t, coordinates: roundCoords(feature.geometry.coordinates) },
    properties: { class: cls, ...(typeof name === "string" && name ? { name } : {}) },
  };
}

function writeBoth(features: GeoJSONFeature[]): void {
  const out: FeatureCollection = { type: "FeatureCollection", features };
  const json = JSON.stringify(out);
  for (const target of [OUT_WEB, OUT_IOS]) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json, "utf8");
    console.log(`[OK]    wrote ${(json.length / 1024).toFixed(1)} KB → ${path.relative(REPO_ROOT, target)}`);
  }
}

// ---------------------------------------------------------------------------
// Source 1: local full bike network → filter by FacilityType
// ---------------------------------------------------------------------------

function fromLocalNetwork(): GeoJSONFeature[] {
  const fc = JSON.parse(fs.readFileSync(LOCAL_INPUT, "utf8")) as FeatureCollection;
  const kept: GeoJSONFeature[] = [];
  for (const f of fc.features ?? []) {
    const cls = normalizeClass(f.properties?.[PBOT_CLASS_FIELD]);
    if (!KEEP_CLASSES.has(cls)) continue;
    const trimmed = trim(f, cls, f.properties?.["Name"] ?? f.properties?.["StreetName"]);
    if (trimmed) kept.push(trimmed);
  }
  console.log(`[source] local bicycle-network.geojson → kept ${kept.length}/${fc.features?.length ?? 0}`);
  return kept;
}

// ---------------------------------------------------------------------------
// Source 2: live ArcGIS Neighborhood Greenways fetch
// ---------------------------------------------------------------------------

async function fromArcGIS(): Promise<GeoJSONFeature[]> {
  const url = GREENWAYS_ARCGIS_URL + GREENWAYS_QUERY;
  console.log(`[source] fetching PBOT Neighborhood Greenways\n         ${url}`);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`ArcGIS HTTP ${res.status} ${res.statusText}`);
  const fc = JSON.parse(await res.text()) as FeatureCollection & { error?: unknown };
  if ((fc as { error?: unknown }).error) throw new Error(`ArcGIS error: ${JSON.stringify((fc as { error?: unknown }).error)}`);

  const kept: GeoJSONFeature[] = [];
  for (const f of fc.features ?? []) {
    const trimmed = trim(f, "greenway", f.properties?.["SegmentName"]);
    if (trimmed) kept.push(trimmed);
  }
  console.log(`[source] ArcGIS → kept ${kept.length}/${fc.features?.length ?? 0} greenway segments`);
  return kept;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let features: GeoJSONFeature[];
  if (fs.existsSync(LOCAL_INPUT)) {
    features = fromLocalNetwork();
  } else {
    features = await fromArcGIS();
  }

  if (features.length === 0) {
    console.error("[ERROR] no greenway features produced — aborting (won't overwrite with empty set)");
    process.exit(1);
  }

  writeBoth(features);
  console.log(`\nDone — ${features.length} greenway features.`);
}

main().catch((err) => {
  console.error("[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
