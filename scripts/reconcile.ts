/**
 * reconcile.ts
 *
 * Emits divergence reports comparing PBOT's bicycle network against OSM.
 * Implements the two-direction comparison described in docs/pbot-osm-reconciliation.md.
 *
 * DESIGN CHOICE — standalone re-runner vs sidecar consumer:
 *   This script is implemented as a standalone re-runner of the spatial join.
 *   It reads the intermediate files produced by build-graph.ts rather than
 *   importing that module, which avoids circular dependencies and lets you run
 *   `npm run reconcile` independently after any data update. The join logic
 *   (buffer + overlap) is re-run here because the in-memory join state from
 *   build-graph.ts is not persisted — only way-tags.json and osm-lcn-ways.json
 *   are. Re-running the join on these smaller datasets (PBOT lines × OSM LCN
 *   ways) is fast and avoids complex IPC between scripts.
 *
 * READS:
 *   data/pbot/current/bicycle-network.geojson
 *   data/reconciled/current/way-tags.json       — matched ways (built by build-graph)
 *   data/reconciled/current/osm-lcn-ways.json   — LCN-tagged OSM ways
 *   data/reconciled/current/osm-ways.geojson    — all exported OSM ways
 *
 * WRITES:
 *   data/reconciled/current/pbot-not-in-osm.csv
 *   data/reconciled/current/osm-lcn-not-in-pbot.csv
 *
 * EXIT CODES:
 *   0  success
 *   1  runtime error
 *   2  config error (missing input files — run build:graph first)
 *
 * USAGE:
 *   npm run reconcile
 *   npm run reconcile -- --force   # overwrite existing CSVs
 */

import * as fs from "fs";
import * as path from "path";
import * as turf from "@turf/turf";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Geometry,
  GeoJsonProperties,
} from "geojson";

// ---------------------------------------------------------------------------
// Configuration (must match build-graph.ts)
// ---------------------------------------------------------------------------

/** Buffer distance in metres for PBOT→OSM join */
const JOIN_BUFFER_M = 5;

/** Minimum overlap fraction to count as a match */
const OVERLAP_THRESHOLD = 0.5;

/** PBOT field holding the facility class */
const PBOT_CLASS_FIELD = "FacilityType";

/** PBOT classes that count as "greenway" for the pbot-not-in-osm report */
const GREENWAY_CLASSES = new Set([
  "neighborhood greenway",
  "greenway",
]);

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const DATA_PBOT_CURRENT = path.join(REPO_ROOT, "data", "pbot", "current");
const DATA_RECONCILED_CURRENT = path.join(
  REPO_ROOT,
  "data",
  "reconciled",
  "current"
);

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function requireFile(p: string, label: string): void {
  if (!fs.existsSync(p)) {
    console.error(
      `\n[ERROR] Missing required input: ${label}\n` +
        `        Expected at: ${p}\n` +
        `        Run: npm run build:graph first.\n`
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// GeoJSON load helpers
// ---------------------------------------------------------------------------

function loadGeojson(filePath: string): FeatureCollection {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as FeatureCollection;
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

// ---------------------------------------------------------------------------
// Spatial helpers (mirrors build-graph.ts)
// ---------------------------------------------------------------------------

type BufferFeature = Feature<Polygon | MultiPolygon, GeoJsonProperties>;

function overlapFraction(
  line: Feature<LineString>,
  polygon: BufferFeature
): number {
  const coords = line.geometry.coordinates;
  if (coords.length < 2) return 0;

  let totalLength = 0;
  let insideLength = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const segStart = turf.point(coords[i] as [number, number]);
    const segEnd = turf.point(coords[i + 1] as [number, number]);
    const segLen = turf.distance(segStart, segEnd, { units: "meters" });
    totalLength += segLen;

    const mid = turf.midpoint(segStart, segEnd);
    if (turf.booleanPointInPolygon(mid, polygon)) {
      insideLength += segLen;
    }
  }

  return totalLength > 0 ? insideLength / totalLength : 0;
}

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------

function escapeCsv(val: unknown): string {
  const s = String(val ?? "");
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsvRow(vals: unknown[]): string {
  return vals.map(escapeCsv).join(",");
}

// ---------------------------------------------------------------------------
// Report 1: PBOT greenway segments with no OSM match
// ---------------------------------------------------------------------------

interface PbotNotInOsmRow {
  pbot_id: string;
  name: string;
  length_m: number;
  lng: number;
  lat: number;
}

async function buildPbotNotInOsm(
  pbotNetwork: FeatureCollection,
  wayTagsMap: Record<string, unknown>
): Promise<PbotNotInOsmRow[]> {
  console.log(`\n[reconcile] Building PBOT buffers for reverse join…`);

  // Collect all matched OSM way centroids from way-tags.json so we can do a
  // reverse lookup: for each PBOT segment, does any matched OSM way centroid
  // fall within its buffer?
  //
  // Alternative approach: buffer each PBOT line and check whether any key in
  // wayTagsMap has a centroid inside — but we don't store centroid in
  // way-tags.json in a convenient form for this direction. Instead we re-buffer
  // PBOT lines and check whether the number of matched OSM centroids inside is
  // > 0.

  const matchedCentroids = Object.values(wayTagsMap).map((tag) => {
    const t = tag as { centroid_lng: number; centroid_lat: number };
    return turf.point([t.centroid_lng, t.centroid_lat]);
  });

  const rows: PbotNotInOsmRow[] = [];

  for (const feature of pbotNetwork.features) {
    if (!feature.geometry) continue;
    if (
      feature.geometry.type !== "LineString" &&
      feature.geometry.type !== "MultiLineString"
    )
      continue;

    const props = feature.properties ?? {};
    const rawClass = String(props[PBOT_CLASS_FIELD] ?? "").trim().toLowerCase();

    if (!GREENWAY_CLASSES.has(rawClass)) continue;

    // Buffer this PBOT segment.
    // Cast through unknown to select the single-Feature overload of turf.buffer
    // (Feature input → Feature<Polygon|MultiPolygon> output, not FeatureCollection).
    const poly = turf.buffer(
      feature as unknown as Feature<LineString>,
      JOIN_BUFFER_M / 1000,
      { units: "kilometers" }
    ) as BufferFeature | undefined;
    if (!poly) continue;

    // Check whether any matched OSM centroid falls inside
    const hasMatch = matchedCentroids.some((pt) =>
      turf.booleanPointInPolygon(pt, poly)
    );

    if (!hasMatch) {
      const centroid = turf.centroid(feature as Feature<Geometry>);
      const [lng, lat] = centroid.geometry.coordinates;
      const length_m = turf.length(
        feature as Feature<LineString | MultiLineString>,
        { units: "meters" }
      );

      rows.push({
        pbot_id: String(props["OBJECTID"] ?? props["objectid"] ?? props["FID"] ?? ""),
        name: String(props["StreetName"] ?? props["Name"] ?? props["name"] ?? ""),
        length_m: Math.round(length_m * 10) / 10,
        lng: Math.round(lng * 1e6) / 1e6,
        lat: Math.round(lat * 1e6) / 1e6,
      });
    }
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Report 2: OSM LCN ways with no PBOT match
// ---------------------------------------------------------------------------

interface OsmLcnNotInPbotRow {
  osm_way_id: string;
  name: string;
  length_m: number;
  lng: number;
  lat: number;
}

interface LcnWayRecord {
  id: string;
  name: string | null;
  length_m: number;
  centroid: [number, number];
}

async function buildOsmLcnNotInPbot(
  lcnWays: LcnWayRecord[],
  wayTagsMap: Record<string, unknown>
): Promise<OsmLcnNotInPbotRow[]> {
  // LCN ways that are NOT in wayTagsMap = no PBOT match was found during
  // the build-graph spatial join. We simply diff the two lists.
  const matchedIds = new Set(Object.keys(wayTagsMap));

  const rows: OsmLcnNotInPbotRow[] = [];

  for (const way of lcnWays) {
    if (matchedIds.has(way.id)) continue; // PBOT matched — not a divergence

    rows.push({
      osm_way_id: way.id,
      name: way.name ?? "",
      length_m: Math.round(way.length_m * 10) / 10,
      lng: Math.round(way.centroid[0] * 1e6) / 1e6,
      lat: Math.round(way.centroid[1] * 1e6) / 1e6,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// CSV writers
// ---------------------------------------------------------------------------

async function writePbotNotInOsm(
  outPath: string,
  rows: PbotNotInOsmRow[]
): Promise<void> {
  const header = "pbot_id,name,length_m,lng,lat";
  const lines = [
    header,
    ...rows.map((r) =>
      toCsvRow([r.pbot_id, r.name, r.length_m, r.lng, r.lat])
    ),
  ];
  await fs.promises.writeFile(outPath, lines.join("\n") + "\n", "utf8");
}

async function writeOsmLcnNotInPbot(
  outPath: string,
  rows: OsmLcnNotInPbotRow[]
): Promise<void> {
  const header = "osm_way_id,name,length_m,lng,lat";
  const lines = [
    header,
    ...rows.map((r) =>
      toCsvRow([r.osm_way_id, r.name, r.length_m, r.lng, r.lat])
    ),
  ];
  await fs.promises.writeFile(outPath, lines.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  // Resolve paths
  const pbotNetworkPath = path.join(
    DATA_PBOT_CURRENT,
    "bicycle-network.geojson"
  );
  const wayTagsPath = path.join(DATA_RECONCILED_CURRENT, "way-tags.json");
  const lcnWaysPath = path.join(DATA_RECONCILED_CURRENT, "osm-lcn-ways.json");

  requireFile(pbotNetworkPath, "PBOT bicycle network GeoJSON");
  requireFile(wayTagsPath, "way-tags.json (run build:graph first)");
  requireFile(lcnWaysPath, "osm-lcn-ways.json (run build:graph first)");

  // Output paths (write into same reconciled/current folder)
  const outPbotNotInOsm = path.join(
    DATA_RECONCILED_CURRENT,
    "pbot-not-in-osm.csv"
  );
  const outOsmLcnNotInPbot = path.join(
    DATA_RECONCILED_CURRENT,
    "osm-lcn-not-in-pbot.csv"
  );

  if (
    fs.existsSync(outPbotNotInOsm) &&
    fs.existsSync(outOsmLcnNotInPbot) &&
    !force
  ) {
    console.log(
      `\n[skip]  Divergence CSVs already exist. Use --force to regenerate.`
    );
    console.log(`        ${outPbotNotInOsm}`);
    console.log(`        ${outOsmLcnNotInPbot}`);
    process.exit(0);
  }

  // Load inputs
  console.log(`\n[load]  PBOT bicycle network…`);
  const pbotNetwork = loadGeojson(pbotNetworkPath);
  console.log(`        ${pbotNetwork.features.length} features`);

  console.log(`[load]  way-tags.json…`);
  const wayTagsMap = loadJson<Record<string, unknown>>(wayTagsPath);
  console.log(`        ${Object.keys(wayTagsMap).length} matched ways`);

  console.log(`[load]  osm-lcn-ways.json…`);
  const lcnWays = loadJson<LcnWayRecord[]>(lcnWaysPath);
  console.log(`        ${lcnWays.length} LCN ways`);

  // Report 1: PBOT greenways not in OSM
  console.log(`\n[report] PBOT greenways with no OSM match…`);
  const pbotNotInOsm = await buildPbotNotInOsm(pbotNetwork, wayTagsMap);
  await writePbotNotInOsm(outPbotNotInOsm, pbotNotInOsm);
  console.log(
    `[write]  pbot-not-in-osm.csv — ${pbotNotInOsm.length} rows`
  );

  // Report 2: OSM LCN ways not in PBOT
  console.log(`\n[report] OSM LCN ways with no PBOT match…`);
  const osmLcnNotInPbot = await buildOsmLcnNotInPbot(lcnWays, wayTagsMap);
  await writeOsmLcnNotInPbot(outOsmLcnNotInPbot, osmLcnNotInPbot);
  console.log(
    `[write]  osm-lcn-not-in-pbot.csv — ${osmLcnNotInPbot.length} rows`
  );

  // One-line summary (required by spec)
  console.log(
    `\nReconcile: ${pbotNotInOsm.length} PBOT greenways unmatched in OSM | ${osmLcnNotInPbot.length} OSM LCN ways unmatched in PBOT`
  );
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
