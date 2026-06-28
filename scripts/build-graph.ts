/**
 * build-graph.ts
 *
 * Spatial-joins PBOT bicycle network classifications onto OSM ways from the
 * cropped Portland PBF, then emits a way-tags sidecar JSON that the Valhalla
 * build step consumes via a Lua tagging callback.
 *
 * READS:
 *   data/pbot/current/bicycle-network.geojson  — PBOT line features
 *   data/pbot/current/difficult-crossings.geojson  — PBOT point features
 *   data/osm/current/portland.osm.pbf  — cropped Portland OSM
 *
 * WRITES:
 *   data/reconciled/<YYYY-MM-DD>/portland-tagged.osm.pbf  — OSM PBF with ways
 *       annotated; note: PBF itself is NOT modified (OSM tags are injected via
 *       sidecar — see ARCHITECTURE NOTE below)
 *   data/reconciled/<YYYY-MM-DD>/way-tags.json  — mapping of osm_way_id →
 *       { bicycle_network_class, difficult_crossing_penalty_s }
 *   data/reconciled/<YYYY-MM-DD>/osm-ways.geojson  — OSM ways as GeoJSON
 *       (intermediate, kept for reconcile.ts reuse)
 *   data/reconciled/<YYYY-MM-DD>/manifest.json
 *   data/reconciled/current  (symlink → dated folder)
 *
 * EXTERNAL DEPS:
 *   osmium-tool (CLI) — brew install osmium-tool
 *
 * ARCHITECTURE NOTE — why a sidecar instead of a modified PBF:
 *   Injecting arbitrary new tags into a PBF requires either a C++ osmium
 *   writer or a complex pbf-writer library. For v0.1 we keep things simple:
 *   `osmium export` converts OSM ways to GeoJSON, we do the spatial join in
 *   TypeScript using @turf/turf, and write a JSON sidecar mapping way_id →
 *   bicycle_network_class. The Valhalla build step reads this sidecar via a
 *   Lua callback in routing/valhalla.json. This avoids PBF serialisation
 *   entirely while keeping all the join logic in one place.
 *
 *   The "portland-tagged.osm.pbf" written here is just a symlink/copy of the
 *   input PBF; the real enrichment lives in way-tags.json.
 *
 * PBOT → internal class mapping:
 *   PBOT field: FacilityType (exact values may vary — run with --list-classes
 *   to dump observed values from your fetched GeoJSON)
 *   "Neighborhood Greenway"    → greenway
 *   "Protected Bike Lane"      → protected
 *   "Buffered Bike Lane"       → buffered
 *   "Bike Lane"                → standard
 *   "Shared Roadway"           → standard
 *   "Off-Street Path"          → off_street
 *   "Multi-Use Path"           → off_street
 *   Anything else              → standard  (with a warning logged)
 *
 * USAGE:
 *   npm run build:graph
 *   npm run build:graph -- --force       # rebuild even if today's output exists
 *   npm run build:graph -- --list-classes # dump PBOT class values and exit
 *
 * EXIT CODES:
 *   0  success
 *   1  runtime error
 *   2  config error (osmium not found, input files missing)
 */

import * as fs from "fs";
import * as path from "path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "child_process";
import * as turf from "@turf/turf";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Point,
  GeoJsonProperties,
  Geometry,
} from "geojson";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Buffer distance for spatial join in metres */
const JOIN_BUFFER_M = 5;

/** Fraction of OSM way length that must overlap a PBOT buffer to count */
const OVERLAP_THRESHOLD = 0.5;

/** Difficult crossing search radius in metres */
const CROSSING_SEARCH_M = 30;

/** Penalty applied per difficult crossing on a way (seconds) */
const CROSSING_PENALTY_S = 60;

// Field holding the bike facility classification in the source network.
// We now consume web/public/bike-network.geojson (produced by
// scripts/export-bike-network.ts from the LIVE portlandmaps layer 75), whose
// features carry a normalized `class` field. The old data/pbot fetch hit a
// retired ArcGIS FeatureServer (HTTP 400) and is no longer used for routing.
const PBOT_CLASS_FIELD = "class";

type NormalizedClass =
  | "off_street"
  | "greenway"
  | "protected"
  | "buffered"
  | "standard"
  | "calm" // SR_LT — recommended low-traffic shared roadway (no built facility)
  | "calm_mod"; // SR_MT — recommended moderate-traffic shared roadway

/**
 * Maps a source classification value to our internal NormalizedClass.
 * Keys are lower-cased for case-insensitive matching. The first group is the
 * bike-network.geojson `class` vocabulary; the second is the legacy PBOT
 * `FacilityType` vocabulary, kept for backward compatibility.
 */
const CLASS_MAP: Record<string, NormalizedClass> = {
  // bike-network.geojson `class` values (current source of truth)
  greenway: "greenway",
  protected: "protected",
  buffered: "buffered",
  lane: "standard",
  shared: "standard",
  path: "off_street",
  calm: "calm", // SR_LT recommended shared roadway
  calm_mod: "calm_mod", // SR_MT recommended shared roadway
  // legacy PBOT FacilityType values
  "neighborhood greenway": "greenway",
  "protected bike lane": "protected",
  "buffered bike lane": "buffered",
  "bike lane": "standard",
  "shared roadway": "standard",
  "off-street path": "off_street",
  "multi-use path": "off_street",
  "shared use path": "off_street",
  trail: "off_street",
};

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PBOT_CURRENT = path.join(REPO_ROOT, "data", "pbot", "current");
const DATA_OSM_CURRENT = path.join(REPO_ROOT, "data", "osm", "current");
const DATA_RECONCILED = path.join(REPO_ROOT, "data", "reconciled");
const CURRENT_LINK = path.join(DATA_RECONCILED, "current");
// Live classified bike network (from `npm run export:bike-network`). This is the
// PBOT classification source for the routing graph — single source of truth
// shared with the web/iOS display overlay.
const BIKE_NETWORK_PATH = path.join(REPO_ROOT, "web", "public", "bike-network.geojson");
// NOTE: the built-but-unpublished PBOT supplement (data/pbot-supplement/) is
// merged UPSTREAM into bike-network.geojson by `npm run export:bike-network`, so
// it arrives here as ordinary PBOT features — no separate merge needed. See
// docs/data-sources.md.

function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// osmium check
// ---------------------------------------------------------------------------

function checkOsmium(): void {
  const result = spawnSync("osmium", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.error(
      `\n[ERROR] osmium-tool is not installed or not on PATH.\n` +
        `\n` +
        `        Install it with:\n` +
        `          brew install osmium-tool\n` +
        `\n` +
        `        Or see: https://osmcode.org/osmium-tool/\n`
    );
    process.exit(2);
  }
  const version = (result.stdout || result.stderr || "").split("\n")[0].trim();
  console.log(`[osmium] ${version}`);
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function requireFile(p: string, label: string): void {
  if (!fs.existsSync(p)) {
    console.error(
      `\n[ERROR] Missing required input: ${label}\n` +
        `        Expected at: ${p}\n` +
        `        Run: npm run fetch:pbot  (and/or npm run fetch:osm) first.\n`
    );
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// osmium export: PBF → GeoJSON for ways
// ---------------------------------------------------------------------------

function osmiumExportWays(pbfPath: string, geojsonPath: string): void {
  console.log(`\n[osmium] exporting ways to GeoJSON…`);
  console.log(`         ${pbfPath}`);
  console.log(`         → ${geojsonPath}`);

  // Pre-filter to highway ways only. We only ever bake tags onto roads/paths,
  // and the full extract (~1M ways incl. buildings/water/landuse) makes both the
  // JSON parse and the spatial join blow up in memory/time. This cuts it to the
  // ~150k routable ways.
  const highwaysPbf = path.join(path.dirname(geojsonPath), ".highways.osm.pbf");
  console.log(`[osmium] filtering to highway ways → ${path.basename(highwaysPbf)}`);
  const filt = spawnSync(
    "osmium",
    ["tags-filter", pbfPath, "w/highway", "-o", highwaysPbf, "--overwrite"],
    { stdio: "inherit" }
  );
  if (filt.error) throw new Error(`osmium tags-filter: ${filt.error.message}`);
  if (filt.status !== 0)
    throw new Error(`osmium tags-filter exited with status ${filt.status}`);
  pbfPath = highwaysPbf;

  // CRITICAL: by default `osmium export` does NOT emit the OSM object id into
  // feature properties — only tags. Without this, props["@id"] is undefined and
  // the wayId below silently falls back to a synthetic sequential index, so the
  // way-tags sidecar ends up keyed by meaningless indices that never match
  // Valhalla's real way_id in graph.lua (the whole greenway cost model goes
  // dead). We pass a config enabling the `id` attribute so each feature gets a
  // bare-numeric "@id" (e.g. {"@type":"way","@id":987654,…}) that matches
  // graph.lua's tostring(way_id) lookup.
  const cfgPath = path.join(path.dirname(geojsonPath), ".osmium-export-config.json");
  fs.writeFileSync(
    cfgPath,
    JSON.stringify({ attributes: { type: true, id: true } }),
    "utf8"
  );

  // Only export ways (no nodes/relations) and include all tags
  const result = spawnSync(
    "osmium",
    [
      "export",
      pbfPath,
      "--config",
      cfgPath,
      "--output",
      geojsonPath,
      "--overwrite",
      "--output-format",
      "geojson",
      // Export only ways with geometry; nodes become LineStrings
      "--geometry-types",
      "linestring",
    ],
    { stdio: "inherit" }
  );

  if (result.error) throw new Error(`osmium spawn: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`osmium export exited with status ${result.status}`);

  const stat = fs.statSync(geojsonPath);
  console.log(
    `[OK]     ways GeoJSON — ${(stat.size / 1024 / 1024).toFixed(1)} MB`
  );
}

// ---------------------------------------------------------------------------
// Tag baking: write standard OSM bike tags onto matched ways in the PBF
// ---------------------------------------------------------------------------
//
// Valhalla's bicycle costing ignores custom per-edge tags and only reads
// standard OSM tags (cycleway / bicycle / lcn). Rather than maintain a custom
// Lua tag-transform (which must REPLACE Valhalla's full default Lua and be kept
// version-matched), we bake the standard tags straight into the PBF here, so
// STOCK Valhalla with its default Lua already prefers our greenways.
//
// Mapping mirrors routing/conf/graph.lua's intent. Crucially, greenways get
// cycleway=track so they outrank painted bike lanes (cycleway=lane), which
// Valhalla would otherwise prefer — the main cause of mid-route defection.

// NOTE (validated 2026-06-20 against a local stock-Valhalla tile build): baking
// these tags does NOT reliably bias routes onto greenways — Valhalla scores a
// quiet residential and a residential-with-bike-infra as near-equal, and
// use_roads 0 vs 1 produced identical routes on test ODs. highway=cycleway (a
// stronger lever) made coverage WORSE on several routes. Conclusion: strong
// greenway adherence needs custom costing (BRouter-style per-tag profile) or a
// route-snapping post-process, not stock-Valhalla tag injection. These tags are
// kept as a mild, harmless preference; see routing/VALIDATION.md.
const CLASS_TAGS: Record<NormalizedClass, Record<string, string>> = {
  off_street: { cycleway: "track", bicycle: "designated", lcn: "yes" },
  greenway: { cycleway: "track", bicycle: "designated", lcn: "yes" },
  protected: { cycleway: "track", bicycle: "designated" },
  buffered: { cycleway: "lane" },
  standard: { cycleway: "lane" },
  // calm classes carry NO facility tag (no lane/track exists on these recommended
  // quiet streets — tagging cycleway= would fake infrastructure). Instead a custom
  // marker the self-build BRouter profiles read for a small graded preference
  // (pbot_calm=low < greenway; pbot_calm=moderate < low). Decoded via lookups.dat.
  calm: { pbot_calm: "low" },
  calm_mod: { pbot_calm: "moderate" },
};

function runOsmium(args: string[], label: string): void {
  const result = spawnSync("osmium", args, { stdio: "inherit" });
  if (result.error) throw new Error(`osmium ${label}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`osmium ${label} exited with status ${result.status}`);
}

/**
 * Stream the OSM PBF through OPL (osmium's line-based text format), merging the
 * per-class standard tags onto each matched way, and write a tagged PBF.
 * Existing tags are preserved; our keys overwrite any same-named tags.
 */
async function bakeTagsIntoPbf(
  osmPbfPath: string,
  wayTags: WayTagMap,
  taggedPbfPath: string,
  outDir: string
): Promise<void> {
  const oplPath = path.join(outDir, "portland.opl");
  const taggedOplPath = path.join(outDir, "portland-tagged.opl");

  console.log(`\n[bake]   PBF → OPL…`);
  runOsmium(["cat", "-f", "opl", osmPbfPath, "-o", oplPath, "--overwrite"], "cat→opl");

  // way_id → tags to set
  const wayClass = new Map<string, Record<string, string>>();
  for (const [id, tag] of wayTags) {
    wayClass.set(id, CLASS_TAGS[tag.bicycle_network_class]);
  }

  console.log(`[bake]   injecting tags onto ${wayClass.size} ways…`);
  const rl = createInterface({
    input: fs.createReadStream(oplPath),
    crlfDelay: Infinity,
  });
  const out = fs.createWriteStream(taggedOplPath);
  let taggedWays = 0;

  for await (const line of rl) {
    let toWrite = line;
    if (line.charCodeAt(0) === 119 /* 'w' */) {
      const sp = line.split(" ");
      const id = sp[0].slice(1);
      const overrides = wayClass.get(id);
      if (overrides) {
        // Tags live in the token beginning with 'T'; nodes in the 'N' token.
        let ti = sp.findIndex((t) => t.charCodeAt(0) === 84 /* 'T' */);
        if (ti === -1) {
          // No tags column (unexpected): insert one before the nodes token.
          const ni = sp.findIndex((t) => t.charCodeAt(0) === 78 /* 'N' */);
          ti = ni === -1 ? sp.length : ni;
          sp.splice(ti, 0, "T");
        }
        const body = sp[ti].slice(1);
        const tags = new Map<string, string>();
        if (body) {
          for (const kv of body.split(",")) {
            const eq = kv.indexOf("=");
            tags.set(kv.slice(0, eq), kv.slice(eq + 1));
          }
        }
        for (const [k, v] of Object.entries(overrides)) tags.set(k, v);
        sp[ti] = "T" + [...tags].map(([k, v]) => `${k}=${v}`).join(",");
        toWrite = sp.join(" ");
        taggedWays++;
      }
    }
    if (!out.write(toWrite + "\n")) {
      await new Promise<void>((res) => out.once("drain", () => res()));
    }
  }
  await new Promise<void>((res) => out.end(res));

  console.log(`[bake]   OPL → PBF (${taggedWays} ways tagged)…`);
  runOsmium(
    ["cat", "-f", "pbf", taggedOplPath, "-o", taggedPbfPath, "--overwrite"],
    "cat→pbf"
  );

  // Clean up the large intermediate OPL files.
  for (const p of [oplPath, taggedOplPath]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
  const mb = (fs.statSync(taggedPbfPath).size / 1024 / 1024).toFixed(1);
  console.log(`[write]  portland-tagged.osm.pbf — ${mb} MB (${taggedWays} ways tagged)`);
}

// ---------------------------------------------------------------------------
// PBOT class normalisation
// ---------------------------------------------------------------------------

function normalizePbotClass(raw: unknown): NormalizedClass {
  if (typeof raw !== "string") return "standard";
  const key = raw.trim().toLowerCase();
  return CLASS_MAP[key] ?? "standard";
}

// ---------------------------------------------------------------------------
// GeoJSON load helpers
// ---------------------------------------------------------------------------

function loadGeojson(filePath: string): FeatureCollection {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text) as FeatureCollection;
}

// ---------------------------------------------------------------------------
// Spatial join: PBOT lines onto OSM ways
// ---------------------------------------------------------------------------

interface WayTag {
  bicycle_network_class: NormalizedClass;
  difficult_crossing_penalty_s: number;
  /** OSM way name if present */
  name?: string;
  /** WGS84 centroid of the way */
  centroid_lng: number;
  centroid_lat: number;
  length_m: number;
}

type WayTagMap = Map<string, WayTag>;

/** Normalised buffer type — always a single Feature for booleanPointInPolygon */
type BufferFeature = Feature<Polygon | MultiPolygon, GeoJsonProperties>;

/**
 * For a LineString geometry, return the fraction of the line that falls
 * within the given polygon (sampled by splitting into segments).
 */
function overlapFraction(
  line: Feature<LineString>,
  polygon: BufferFeature
): number {
  const coords = line.geometry.coordinates;
  if (coords.length < 2) return 0;

  // Sample points along the line at ~2m intervals using turf
  let totalLength = 0;
  let insideLength = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const segStart = turf.point(coords[i] as [number, number]);
    const segEnd = turf.point(coords[i + 1] as [number, number]);
    const segLen = turf.distance(segStart, segEnd, { units: "meters" });
    totalLength += segLen;

    // Check midpoint of each segment
    const mid = turf.midpoint(segStart, segEnd);
    if (turf.booleanPointInPolygon(mid, polygon)) {
      insideLength += segLen;
    }
  }

  return totalLength > 0 ? insideLength / totalLength : 0;
}

/**
 * Build a map of PBOT buffered polygons keyed by normalised class.
 * We buffer each PBOT line segment by JOIN_BUFFER_M metres.
 */
function buildPbotBuffers(
  pbotNetwork: FeatureCollection
): Array<{
  poly: BufferFeature;
  cls: NormalizedClass;
  rawClass: string;
  bbox: [number, number, number, number];
}> {
  const buffers: Array<{
    poly: BufferFeature;
    cls: NormalizedClass;
    rawClass: string;
    bbox: [number, number, number, number];
  }> = [];

  const unknownClasses = new Set<string>();
  let bufferFailures = 0;

  for (const feature of pbotNetwork.features) {
    if (
      !feature.geometry ||
      (feature.geometry.type !== "LineString" &&
        feature.geometry.type !== "MultiLineString")
    ) {
      continue;
    }

    const rawClass = feature.properties?.[PBOT_CLASS_FIELD] as unknown;
    const cls = normalizePbotClass(rawClass);

    if (
      typeof rawClass === "string" &&
      !CLASS_MAP[rawClass.trim().toLowerCase()]
    ) {
      unknownClasses.add(rawClass);
    }

    // Cast through unknown to select the single-Feature buffer overload.
    // When input is a Feature (not FeatureCollection), turf.buffer always
    // returns Feature<Polygon|MultiPolygon>|undefined — never a FeatureCollection.
    // A few source features have degenerate geometry that makes turf throw
    // ("coordinates must contain numbers"); skip those rather than abort.
    let poly: BufferFeature | undefined;
    try {
      poly = turf.buffer(
        feature as unknown as Feature<LineString>,
        JOIN_BUFFER_M / 1000, // turf uses km
        { units: "kilometers" }
      ) as BufferFeature | undefined;
    } catch {
      bufferFailures++;
      continue;
    }

    if (poly) {
      buffers.push({
        poly,
        cls,
        rawClass: String(rawClass ?? ""),
        bbox: turf.bbox(poly) as [number, number, number, number],
      });
    }
  }

  if (bufferFailures > 0) {
    console.log(`[WARN]   ${bufferFailures} PBOT features skipped (un-bufferable geometry)`);
  }

  if (unknownClasses.size > 0) {
    console.log(
      `[WARN]   Unknown PBOT class values (mapped to 'standard'): ${[...unknownClasses].join(", ")}`
    );
  }

  return buffers;
}

/**
 * Main spatial join: OSM ways × PBOT buffers.
 * Returns a WayTagMap with one entry per matched OSM way.
 */
function spatialJoin(
  osmWays: FeatureCollection,
  pbotBuffers: ReturnType<typeof buildPbotBuffers>,
  difficultCrossings: FeatureCollection
): {
  wayTags: WayTagMap;
  /** OSM ways that are tagged lcn=yes or bicycle=designated */
  lcnWays: Feature[];
  classCounters: Record<NormalizedClass, number>;
} {
  const wayTags: WayTagMap = new Map();
  const lcnWays: Feature[] = [];

  // Priority order: off_street > greenway > protected > buffered > standard >
  // calm > calm_mod. A real built facility (incl. a plain lane = "standard")
  // always wins over a no-facility recommended shared roadway, so a street that
  // is BOTH a facility and SR-recommended keeps its facility class.
  const classPriority: Record<NormalizedClass, number> = {
    off_street: 7,
    greenway: 6,
    protected: 5,
    buffered: 4,
    standard: 3,
    calm: 2,
    calm_mod: 1,
  };

  const classCounters: Record<NormalizedClass, number> = {
    off_street: 0,
    greenway: 0,
    protected: 0,
    buffered: 0,
    standard: 0,
    calm: 0,
    calm_mod: 0,
  };

  // Pre-index difficult crossings as turf points for distance checks
  const crossingPoints = difficultCrossings.features
    .filter((f) => f.geometry?.type === "Point")
    .map((f) => turf.point((f.geometry as Point).coordinates as [number, number]));

  let totalWays = 0;
  let matchedWays = 0;
  let missingIdWays = 0;

  for (const feature of osmWays.features) {
    if (!feature.geometry || feature.geometry.type !== "LineString") continue;
    totalWays++;

    const props = feature.properties ?? {};

    // Track OSM LCN ways for reconcile.ts
    const isLcn =
      props["lcn"] === "yes" || props["bicycle"] === "designated";
    if (isLcn) {
      lcnWays.push(feature);
    }

    // Compute centroid and length for this way
    const wayLine = feature as Feature<LineString>;
    const centroid = turf.centroid(wayLine);
    const [lng, lat] = centroid.geometry.coordinates;
    const length_m = turf.length(wayLine, { units: "meters" });

    // The sidecar MUST be keyed by the real OSM way id so graph.lua's
    // tostring(way_id) lookup matches. osmiumExportWays enables the `id`
    // attribute, so props["@id"] is a bare numeric id. If it's somehow absent
    // we skip the way (a synthetic index would never match and silently break
    // the greenway weighting), and count it so the run is visibly suspect.
    const rawId = props["@id"] ?? props["id"];
    if (rawId === undefined || rawId === null || String(rawId) === "") {
      missingIdWays++;
      continue;
    }
    // Normalize a possible "type_id" form (e.g. "w987654") to the bare number.
    const wayId: string = String(rawId).replace(/^[a-z]/i, "");

    // Find best-priority PBOT match. Prefilter candidate buffers by bbox so we
    // don't run the expensive overlapFraction against all ~6k buffers per way.
    const [wMinX, wMinY, wMaxX, wMaxY] = turf.bbox(wayLine);
    let bestClass: NormalizedClass | null = null;
    let bestPriority = -1;

    for (const { poly, cls, bbox } of pbotBuffers) {
      if (classPriority[cls] <= bestPriority) continue; // can't beat current
      // bbox = [minX, minY, maxX, maxY]; skip if disjoint from the way's bbox.
      if (bbox[0] > wMaxX || bbox[2] < wMinX || bbox[1] > wMaxY || bbox[3] < wMinY) {
        continue;
      }

      const fraction = overlapFraction(wayLine, poly as BufferFeature);
      if (fraction >= OVERLAP_THRESHOLD) {
        bestClass = cls;
        bestPriority = classPriority[cls];
      }
    }

    if (!bestClass) continue;

    matchedWays++;
    classCounters[bestClass]++;

    // Count difficult crossings near this way's midpoint (simple centroid check)
    let crossingPenalty = 0;
    for (const cp of crossingPoints) {
      const dist = turf.distance(cp, centroid, { units: "meters" });
      if (dist <= CROSSING_SEARCH_M) {
        crossingPenalty += CROSSING_PENALTY_S;
      }
    }

    wayTags.set(wayId, {
      bicycle_network_class: bestClass,
      difficult_crossing_penalty_s: crossingPenalty,
      name: typeof props["name"] === "string" ? props["name"] : undefined,
      centroid_lng: lng,
      centroid_lat: lat,
      length_m,
    });
  }

  console.log(
    `\n[join]   ${matchedWays} / ${totalWays} OSM ways matched to PBOT`
  );
  if (missingIdWays > 0) {
    console.log(
      `[WARN]   ${missingIdWays} ways had no @id and were skipped. ` +
        `If this is most of the ways, osmium export is not emitting the id ` +
        `attribute — check osmiumExportWays' --config. The sidecar must be ` +
        `keyed by real OSM way ids or graph.lua's class lookup silently fails.`
    );
  }
  return { wayTags, lcnWays, classCounters };
}

// ---------------------------------------------------------------------------
// Symlink helper
// ---------------------------------------------------------------------------

function updateCurrentSymlink(targetDir: string): void {
  const relTarget = path.basename(targetDir);

  if (fs.existsSync(CURRENT_LINK)) {
    const stat = fs.lstatSync(CURRENT_LINK);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(CURRENT_LINK);
    } else {
      console.error(
        `[WARN] ${CURRENT_LINK} exists but is not a symlink — skipping`
      );
      return;
    }
  }

  fs.symlinkSync(relTarget, CURRENT_LINK);
  console.log(`[link]   data/reconciled/current → ${relTarget}`);
}

// ---------------------------------------------------------------------------
// --list-classes helper
// ---------------------------------------------------------------------------

function listClasses(): void {
  const networkPath = path.join(
    DATA_PBOT_CURRENT,
    "bicycle-network.geojson"
  );
  if (!fs.existsSync(networkPath)) {
    console.error(
      `[ERROR] ${networkPath} not found. Run npm run fetch:pbot first.`
    );
    process.exit(2);
  }

  const fc = loadGeojson(networkPath);
  const counts: Record<string, number> = {};

  for (const f of fc.features) {
    const val = String(f.properties?.[PBOT_CLASS_FIELD] ?? "(null)");
    counts[val] = (counts[val] ?? 0) + 1;
  }

  console.log(
    `\nPBOT ${PBOT_CLASS_FIELD} values in bicycle-network.geojson:\n`
  );
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  for (const [val, count] of sorted) {
    const mapped = normalizePbotClass(val);
    console.log(`  ${String(count).padStart(5)}  ${val}  →  ${mapped}`);
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (process.argv.includes("--list-classes")) {
    listClasses();
    return;
  }

  const force = process.argv.includes("--force");

  checkOsmium();

  // Resolve input paths. Network classification comes from the live
  // bike-network.geojson; difficult crossings are optional (the penalty is
  // deferred, and the legacy PBOT crossings layer is retired).
  const pbotNetworkPath = BIKE_NETWORK_PATH;
  const pbotCrossingsPath = path.join(
    DATA_PBOT_CURRENT,
    "difficult-crossings.geojson"
  );
  const osmPbfPath = path.join(DATA_OSM_CURRENT, "portland.osm.pbf");

  requireFile(pbotNetworkPath, "bike-network GeoJSON (run: npm run export:bike-network)");
  requireFile(osmPbfPath, "Portland OSM PBF (run: npm run fetch:osm)");

  // Output paths
  const dateStr = todayString();
  const outDir = path.join(DATA_RECONCILED, dateStr);
  const wayTagsPath = path.join(outDir, "way-tags.json");
  const osmWaysGeojsonPath = path.join(outDir, "osm-ways.geojson");
  const manifestPath = path.join(outDir, "manifest.json");
  // The "tagged" PBF for v0.1 is the same as input — enrichment is in sidecar
  const taggedPbfPath = path.join(outDir, "portland-tagged.osm.pbf");

  await fs.promises.mkdir(DATA_RECONCILED, { recursive: true });

  if (fs.existsSync(wayTagsPath) && !force) {
    console.log(
      `\n[skip]  ${outDir} already exists. Use --force to rebuild.\n` +
        `        Updating symlink to existing folder.`
    );
    updateCurrentSymlink(outDir);
    process.exit(0);
  }

  await fs.promises.mkdir(outDir, { recursive: true });

  // Log class mapping table
  console.log(`\n[classes] PBOT → internal class mapping:`);
  for (const [raw, cls] of Object.entries(CLASS_MAP)) {
    console.log(`          "${raw}" → ${cls}`);
  }

  // Step 1: Export OSM ways to GeoJSON via osmium
  osmiumExportWays(osmPbfPath, osmWaysGeojsonPath);

  // Step 2: Load PBOT layers
  console.log(`\n[load]   PBOT bicycle network…`);
  const pbotNetwork = loadGeojson(pbotNetworkPath);
  console.log(
    `         ${pbotNetwork.features.length} PBOT features loaded`
  );

  console.log(`[load]   PBOT difficult crossings…`);
  const pbotCrossings: FeatureCollection = fs.existsSync(pbotCrossingsPath)
    ? loadGeojson(pbotCrossingsPath)
    : { type: "FeatureCollection", features: [] };
  console.log(
    `         ${pbotCrossings.features.length} crossing features loaded` +
      (fs.existsSync(pbotCrossingsPath) ? "" : " (none — file absent, penalty deferred)")
  );

  // Step 3: Load OSM ways GeoJSON
  console.log(`\n[load]   OSM ways GeoJSON…`);
  const osmWays = loadGeojson(osmWaysGeojsonPath);
  console.log(`         ${osmWays.features.length} OSM way features loaded`);

  // Step 4: Build PBOT buffers
  console.log(`\n[buffer] Building PBOT buffers (${JOIN_BUFFER_M}m)…`);
  const pbotBuffers = buildPbotBuffers(pbotNetwork);
  console.log(`         ${pbotBuffers.length} buffers built`);

  // Step 5: Spatial join
  console.log(
    `\n[join]   Running spatial join (overlap threshold: ${OVERLAP_THRESHOLD * 100}%)…`
  );
  const { wayTags, lcnWays, classCounters } = spatialJoin(
    osmWays,
    pbotBuffers,
    pbotCrossings
  );

  // Step 6: Write way-tags.json
  const wayTagsObj: Record<string, WayTag> = {};
  for (const [id, tag] of wayTags) {
    wayTagsObj[id] = tag;
  }
  await fs.promises.writeFile(
    wayTagsPath,
    JSON.stringify(wayTagsObj, null, 2),
    "utf8"
  );
  console.log(`\n[write]  way-tags.json — ${wayTags.size} entries`);

  // Step 7: Write lcn-ways list (consumed by reconcile.ts)
  const lcnPath = path.join(outDir, "osm-lcn-ways.json");
  await fs.promises.writeFile(
    lcnPath,
    JSON.stringify(
      lcnWays.map((f) => ({
        id: String(
          f.properties?.["@id"] ?? f.properties?.["id"] ?? ""
        ),
        name: f.properties?.["name"] ?? null,
        length_m:
          f.geometry?.type === "LineString"
            ? turf.length(f as Feature<LineString>, { units: "meters" })
            : 0,
        centroid: turf.centroid(f as Feature<Geometry>).geometry.coordinates,
      })),
      null,
      2
    ),
    "utf8"
  );
  console.log(`[write]  osm-lcn-ways.json — ${lcnWays.length} LCN ways`);

  // Step 8: Bake standard OSM bike tags onto matched ways in the PBF, so STOCK
  // Valhalla (its default Lua) prefers greenways without any custom costing.
  await bakeTagsIntoPbf(osmPbfPath, wayTags, taggedPbfPath, outDir);

  // Step 9: Manifest
  const manifest = {
    builtDate: dateStr,
    generatedAt: new Date().toISOString(),
    inputs: {
      pbotNetwork: pbotNetworkPath,
      pbotCrossings: pbotCrossingsPath,
      osmPbf: osmPbfPath,
    },
    config: {
      joinBufferM: JOIN_BUFFER_M,
      overlapThreshold: OVERLAP_THRESHOLD,
      crossingSearchM: CROSSING_SEARCH_M,
      crossingPenaltyS: CROSSING_PENALTY_S,
      pbotClassField: PBOT_CLASS_FIELD,
    },
    counts: {
      pbotFeatures: pbotNetwork.features.length,
      pbotBuffers: pbotBuffers.length,
      osmWays: osmWays.features.length,
      matchedWays: wayTags.size,
      lcnWays: lcnWays.length,
      byClass: classCounters,
    },
    valhallaNotes:
      "portland-tagged.osm.pbf has standard bike tags (cycleway/bicycle/lcn) " +
      "baked onto matched ways, so STOCK Valhalla prefers greenways with no " +
      "custom Lua. way-tags.json is the way_id→class sidecar used for the bake.",
  };
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[write]  manifest.json`);

  // Step 10: Symlink
  updateCurrentSymlink(outDir);

  // Summary
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Build graph summary:`);
  console.log(
    `  PBOT segments:   ${pbotNetwork.features.length} (${pbotBuffers.length} buffered)`
  );
  console.log(
    `  OSM ways:        ${osmWays.features.length} total, ${wayTags.size} tagged`
  );
  console.log(`  By class:`);
  for (const [cls, count] of Object.entries(classCounters)) {
    if (count > 0) console.log(`    ${cls.padEnd(12)} ${count}`);
  }
  console.log(
    `  Difficult crossings near matched ways: ${[...wayTags.values()].filter((t) => t.difficult_crossing_penalty_s > 0).length}`
  );
  console.log(
    `  LCN ways (for reconcile): ${lcnWays.length}`
  );
  console.log(`${"─".repeat(60)}\n`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
