/**
 * export-bike-network.ts
 *
 * Produces the full "Portland bike map" overlay GeoJSON for the front-ends:
 * every ACTIVE segment of the City's official Bicycle Network, classified by
 * facility type so the map can color greenways AND bike-friendly streets.
 *
 * SOURCE: City of Portland "Bicycle Network" layer (PortlandMaps Open Data).
 *   https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer/75
 *   This single authoritative layer carries both Neighborhood Greenways (NG)
 *   and on-street facilities (PBL/BBL/BL/...) via its `Facility` field. It
 *   replaces the older ArcGIS "Bicycle_Network"/FacilityType layer that PBOT
 *   retired, and supersedes the greenways-only export for display purposes.
 *
 * WRITES: web/public/bike-network.geojson                       (web overlay)
 *         ios/BikeRouteNicePDX/Resources/bike-network.geojson    (bundled iOS)
 *
 * Each feature: { type:"Feature", geometry:LineString|MultiLineString,
 *                 properties:{ class, facility, name? } }
 *   class    — normalized display category (see CLASS_MAP), drives color
 *   facility — raw PBOT code (PBL/BBL/BL/NG/TRL/ESR/ABL/...)
 *   name     — SegmentName when present
 *
 * EXTERNAL DEPS: none (Node built-ins: fs, path, fetch)
 * USAGE:  npm run export:bike-network
 * EXIT CODES: 0 wrote both files · 1 fetch failed / empty result
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

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

// PBOT Facility code -> normalized display class.
// Order of color priority for the map legend: protected > buffered > greenway
// > path > lane > shared.
type DisplayClass =
  | "greenway"
  | "path"
  | "protected"
  | "buffered"
  | "lane"
  | "shared";

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

const OUT_WEB = path.join(REPO_ROOT, "web", "public", "bike-network.geojson");
const OUT_IOS = path.join(
  REPO_ROOT,
  "ios",
  "BikeRouteNicePDX",
  "Resources",
  "bike-network.geojson"
);

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

function trim(feature: GeoJSONFeature): GeoJSONFeature | null {
  if (!feature.geometry) return null;
  const t = feature.geometry.type;
  if (t !== "LineString" && t !== "MultiLineString") return null;
  const facility = String(feature.properties?.["Facility"] ?? "").trim();
  const cls = CLASS_MAP[facility];
  if (!cls) return null; // skip NONE / unrecognized
  const name = feature.properties?.["SegmentName"];
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

async function fetchPage(offset: number): Promise<FeatureCollection> {
  const params = new URLSearchParams({
    where: WHERE,
    outFields: OUT_FIELDS,
    outSR: "4326",
    f: "geojson",
    resultOffset: String(offset),
    resultRecordCount: String(PAGE_SIZE),
    returnGeometry: "true",
  });
  const url = `${LAYER_URL}/query?${params.toString()}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ offset ${offset}`);
  const fc = JSON.parse(await res.text()) as FeatureCollection;
  if (fc.error) throw new Error(`ArcGIS error: ${JSON.stringify(fc.error)}`);
  return fc;
}

function writeBoth(features: GeoJSONFeature[]): void {
  const json = JSON.stringify({ type: "FeatureCollection", features });
  for (const target of [OUT_WEB, OUT_IOS]) {
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
  console.log(`[source] City of Portland Bicycle Network (ACTIVE)\n         ${LAYER_URL}`);
  const kept: GeoJSONFeature[] = [];
  const byClass: Record<string, number> = {};
  let offset = 0;
  let raw = 0;

  // Paginate until a page returns fewer than PAGE_SIZE features.
  for (;;) {
    const fc = await fetchPage(offset);
    const page = fc.features ?? [];
    raw += page.length;
    for (const f of page) {
      const t = trim(f);
      if (t) {
        kept.push(t);
        const c = String(t.properties?.["class"]);
        byClass[c] = (byClass[c] ?? 0) + 1;
      }
    }
    process.stdout.write(`\r[fetch] offset ${offset} → ${raw} raw / ${kept.length} kept`);
    if (page.length < PAGE_SIZE && !fc.exceededTransferLimit) break;
    offset += PAGE_SIZE;
  }
  process.stdout.write("\n");

  if (kept.length === 0) {
    console.error("[ERROR] no features produced — aborting (won't overwrite with empty set)");
    process.exit(1);
  }

  console.log("[classes]", JSON.stringify(byClass));
  writeBoth(kept);
  console.log(`\nDone — ${kept.length} bike-network features.`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
