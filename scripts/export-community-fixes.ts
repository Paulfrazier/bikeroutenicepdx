/**
 * export-community-fixes.ts
 *
 * Merges all admin-approved connector geometry from `data/community-fixes/`
 * into a single `community-fixes.geojson` and writes it to both targets:
 *
 *   web/public/community-fixes.geojson
 *   ios/BikeRouteNicePDX/Resources/community-fixes.geojson
 *
 * SOURCE: `data/community-fixes/<id>.geojson`
 *   Each file is EITHER a bare GeoJSON Feature OR a FeatureCollection.
 *   Only LineString and MultiLineString geometries are kept.
 *   Features with fewer than 2 coordinate positions are dropped (guards the
 *   iOS MKGeoJSONDecoder nilError that blanks the entire overlay on a single
 *   degenerate feature — same pattern as export-arterials.ts).
 *
 * OUTPUT: merged FeatureCollection, coords rounded to 5 decimals (~1 m).
 *   If the source dir has zero qualifying features, an empty FeatureCollection
 *   is still written so the output files always exist and stay in sync.
 *
 * EXTERNAL DEPS: none (Node built-ins: fs, path)
 * USAGE:  npm run export:community-fixes
 * EXIT CODES: 0 wrote both files · 1 unrecoverable error
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SOURCE_DIR = path.join(REPO_ROOT, "data", "community-fixes");

const COORD_PRECISION = 5;

const OUT_PATHS = [
  path.join(REPO_ROOT, "web", "public", "community-fixes.geojson"),
  path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources", "community-fixes.geojson"),
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const round = (n: number) => Number(n.toFixed(COORD_PRECISION));

/** Round all positions in a coordinate array (1-D through 3-D). */
function roundCoords(coords: number[][]): [number, number][] {
  const out: [number, number][] = [];
  for (const pt of coords) {
    out.push([round(pt[0]), round(pt[1])]);
  }
  return out;
}

/** Drop consecutive duplicate points produced by rounding. */
function dedup(coords: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const c of coords) {
    const last = out[out.length - 1];
    if (!last || last[0] !== c[0] || last[1] !== c[1]) out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GeoJSON type (minimal — Node has no built-in GeoJSON typedefs pre-import)
// ---------------------------------------------------------------------------

type Coord = number[];
type GeoGeom =
  | { type: "LineString"; coordinates: Coord[] }
  | { type: "MultiLineString"; coordinates: Coord[][] }
  | { type: string; coordinates: unknown };

interface GeoFeature {
  type: "Feature";
  geometry: GeoGeom | null;
  properties: Record<string, unknown> | null;
}

interface GeoFeatureCollection {
  type: "FeatureCollection";
  features: GeoFeature[];
}

type GeoInput = GeoFeature | GeoFeatureCollection | { type: string };

// ---------------------------------------------------------------------------
// Feature extraction
// ---------------------------------------------------------------------------

/**
 * Extract qualifying Feature objects from a parsed GeoJSON value.
 * Accepts a bare Feature OR a FeatureCollection; skips non-line geometries.
 */
function extractFeatures(raw: GeoInput): GeoFeature[] {
  if (raw.type === "FeatureCollection") {
    return (raw as GeoFeatureCollection).features.filter(
      (f) =>
        f.type === "Feature" &&
        f.geometry !== null &&
        (f.geometry.type === "LineString" || f.geometry.type === "MultiLineString"),
    );
  }
  if (
    raw.type === "Feature" &&
    (raw as GeoFeature).geometry !== null &&
    ((raw as GeoFeature).geometry?.type === "LineString" ||
      (raw as GeoFeature).geometry?.type === "MultiLineString")
  ) {
    return [raw as GeoFeature];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Per-feature processing
// ---------------------------------------------------------------------------

/**
 * Round + dedup coordinates; return null if the result is degenerate (<2 pts).
 * Guards MKGeoJSONDecoder nilError (one bad feature kills the whole overlay).
 */
function processFeature(
  feat: GeoFeature,
): { type: "Feature"; geometry: GeoGeom; properties: Record<string, unknown> } | null {
  const geom = feat.geometry!;
  const props: Record<string, unknown> = {};
  if (feat.properties?.name) props.name = feat.properties.name;

  if (geom.type === "LineString") {
    const coords = dedup(roundCoords(geom.coordinates as Coord[]));
    if (coords.length < 2) return null;
    return { type: "Feature", geometry: { type: "LineString", coordinates: coords }, properties: props };
  }

  if (geom.type === "MultiLineString") {
    const lines = (geom.coordinates as Coord[][])
      .map((line) => dedup(roundCoords(line)))
      .filter((line) => line.length >= 2);
    if (lines.length === 0) return null;
    return {
      type: "Feature",
      geometry: { type: "MultiLineString", coordinates: lines },
      properties: props,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  if (!fs.existsSync(SOURCE_DIR)) {
    console.error(`[ERROR] source dir not found: ${SOURCE_DIR}`);
    process.exit(1);
  }

  const sourceFiles = fs
    .readdirSync(SOURCE_DIR)
    .filter((f) => f.endsWith(".geojson"))
    .sort();

  console.log(`[community-fixes] reading ${sourceFiles.length} source file(s) from data/community-fixes/`);

  const features: ReturnType<typeof processFeature>[] = [];
  let skippedDegenerate = 0;
  let skippedNonLine = 0;

  for (const filename of sourceFiles) {
    const filepath = path.join(SOURCE_DIR, filename);
    let raw: GeoInput;
    try {
      raw = JSON.parse(fs.readFileSync(filepath, "utf8")) as GeoInput;
    } catch (e) {
      console.error(`[WARN] could not parse ${filename}: ${e instanceof Error ? e.message : e} — skipping`);
      continue;
    }

    const candidates = extractFeatures(raw);
    if (candidates.length === 0) {
      console.warn(`[WARN] ${filename}: no LineString/MultiLineString features found — skipping`);
      skippedNonLine++;
      continue;
    }

    for (const feat of candidates) {
      const processed = processFeature(feat);
      if (!processed) {
        skippedDegenerate++;
        continue;
      }
      features.push(processed);
    }
  }

  const fc = {
    type: "FeatureCollection" as const,
    features: features.filter(Boolean) as NonNullable<ReturnType<typeof processFeature>>[],
  };
  const json = JSON.stringify(fc);

  for (const out of OUT_PATHS) {
    fs.writeFileSync(out, json);
    console.log(
      `[OK] ${path.relative(REPO_ROOT, out)} — ${fc.features.length} feature(s), ${(json.length / 1024).toFixed(1)} KB`,
    );
  }

  if (skippedDegenerate > 0) console.warn(`[WARN] ${skippedDegenerate} degenerate feature(s) dropped (<2 points)`);
  if (skippedNonLine > 0) console.warn(`[WARN] ${skippedNonLine} file(s) had no line geometry and were skipped`);

  console.log(`[done] community-fixes: ${fc.features.length} feature(s) written to both targets`);
}

main();
