/**
 * export-speeds.ts
 *
 * Produces a compact "fast streets" overlay: Portland streets with a posted
 * speed of 30 mph or higher. The bike-friendliness classifier uses it (together
 * with high-crash.geojson) as a HAZARD layer — a route segment on a fast street
 * with no separated bike facility is down-rated to the red "busy" danger signal,
 * so the comfort score and coloring reflect how unpleasant fast traffic is even
 * where the arterial-class heuristic alone would miss it.
 *
 * SOURCE: PortlandMaps Open Data — COP_OpenData_Transportation layer 225
 *   "Speed Limits" (posted speed per street segment). Field `SpeedLimit` is a
 *   STRING of mph; we keep only ≥30 (the comfort threshold) via a WHERE IN list.
 *
 * WRITES: web/public/speeds.geojson                      (web overlay)
 *         ios/BikeRouteNicePDX/Resources/speeds.geojson  (bundled iOS)
 *
 * Each feature: { geometry: LineString|MultiLineString, properties: { mph, name? } }
 *
 * EXTERNAL DEPS: none (Node built-ins). USAGE: npm run export:speeds
 * EXIT: 0 wrote both files · 1 fetch failed / empty result
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const LAYER_URL =
  "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer/225";
const PAGE_SIZE = 200; // service maxRecordCount (same as the bike-network layer)
// Posted speeds we treat as "fast" (≥30 mph). SpeedLimit is a string field, so
// we enumerate values rather than use a numeric comparison.
const FAST_SPEEDS = ["30", "35", "40", "45", "50", "55", "60", "65", "70"];
const WHERE = `SpeedLimit IN (${FAST_SPEEDS.map((s) => `'${s}'`).join(",")})`;
const OUT_FIELDS = "SpeedLimit,RoadName";
const COORD_PRECISION = 5;

const OUT_PATHS = [
  path.join(REPO_ROOT, "web", "public", "speeds.geojson"),
  path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources", "speeds.geojson"),
];

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

/** Keep only line geometry with ≥2 real positions (guards iOS MKGeoJSON nilError). */
function trim(feature: GeoJSONFeature): GeoJSONFeature | null {
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
  const mph = Number(String(feature.properties?.["SpeedLimit"] ?? "").trim());
  if (!Number.isFinite(mph) || mph < 30) return null;
  const name = feature.properties?.["RoadName"];
  return {
    type: "Feature",
    geometry: { type: t, coordinates: roundCoords(coords) },
    properties: {
      mph,
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
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "BikeRouteNicePDX/1.0 (speeds export)",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} @ offset ${offset}`);
  const fc = JSON.parse(await res.text()) as FeatureCollection;
  if (fc.error) throw new Error(`ArcGIS error: ${JSON.stringify(fc.error)}`);
  return fc;
}

async function main(): Promise<void> {
  console.log(`[source] PortlandMaps Speed Limits (≥30 mph)\n         ${LAYER_URL}`);
  const kept: GeoJSONFeature[] = [];
  let offset = 0;
  let raw = 0;
  for (;;) {
    const fc = await fetchPage(offset);
    const page = fc.features ?? [];
    raw += page.length;
    for (const f of page) {
      const t = trim(f);
      if (t) kept.push(t);
    }
    process.stdout.write(`\r[fetch] offset ${offset} → ${raw} raw / ${kept.length} kept`);
    if (page.length < PAGE_SIZE && !fc.exceededTransferLimit) break;
    offset += PAGE_SIZE;
  }
  process.stdout.write("\n");

  if (kept.length === 0) {
    console.error("[ERROR] no fast-street features produced — aborting (won't write empty)");
    process.exit(1);
  }

  const json = JSON.stringify({ type: "FeatureCollection", features: kept });
  for (const out of OUT_PATHS) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, json, "utf8");
    console.log(`[OK] ${path.relative(REPO_ROOT, out)} — ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log(`[done] ${kept.length} fast-street segments`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
