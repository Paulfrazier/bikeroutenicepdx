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
 * SOURCE: OpenStreetMap via the Overpass API (no key, ODbL). We pull only the
 *   five arterial highway classes inside the Portland metro bbox — a few
 *   thousand ways, far smaller than the full street network, so no 200 MB PBF
 *   download or osmium dependency is needed.
 *
 * WRITES: web/public/arterials.geojson                       (web overlay)
 *         ios/BikeRouteNicePDX/Resources/arterials.geojson    (bundled iOS)
 *
 * Each feature: { type:"Feature", geometry:LineString,
 *                 properties:{ class, name? } }
 *   class — OSM highway value: motorway|trunk|primary|secondary|tertiary
 *   name  — OSM street name (when tagged); lets the friendliness classifier
 *           apply the user's personal per-street ratings to a bare arterial
 *           (e.g. "drop Lombard") the same way it does to a named bike facility.
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

const OUT_PATHS = [
  path.join(REPO_ROOT, "web", "public", "arterials.geojson"),
  path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources", "arterials.geojson"),
];

// ---------------------------------------------------------------------------
// Overpass response (partial)
// ---------------------------------------------------------------------------

interface OverpassWay {
  type: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
}
interface OverpassResponse {
  elements: OverpassWay[];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const round = (n: number) => Number(n.toFixed(COORD_PRECISION));

async function main(): Promise<void> {
  console.log(`[overpass] fetching arterials for bbox ${BBOX}`);
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // The public Overpass endpoint 406s requests with no UA / Accept header
      // (Node's fetch sends neither by default).
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

  const features: GeoJSON.Feature[] = [];
  const counts: Record<string, number> = {};
  for (const el of data.elements ?? []) {
    if (el.type !== "way" || !el.geometry || el.geometry.length < 2) continue;
    const cls = el.tags?.highway;
    if (!cls || !ARTERIAL_CLASSES.includes(cls)) continue;

    // Round + drop consecutive duplicate points produced by rounding.
    const coords: [number, number][] = [];
    for (const p of el.geometry) {
      const c: [number, number] = [round(p.lon), round(p.lat)];
      const last = coords[coords.length - 1];
      if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
    }
    if (coords.length < 2) continue;

    // Carry the street name through so the friendliness classifier can match a
    // user's per-street rating to a bare arterial (no leading/trailing space).
    const name = el.tags?.name?.trim();
    const properties: Record<string, string> = { class: cls };
    if (name) properties.name = name;

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
  console.log(`[done] ${features.length} arterials`, counts);
}

main().catch((err) => {
  console.error("[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
