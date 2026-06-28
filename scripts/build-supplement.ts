/**
 * build-supplement.ts
 *
 * Resolves a hand-curated manifest of PBOT facilities that are BUILT but not yet
 * in PBOT's published GIS (web/public/bike-network.geojson, ~2023 vintage) into
 * PBOT-style line features the routing pipeline can consume.
 *
 * WHY: build-graph.ts treats bike-network.geojson as ground truth. Facilities
 * opened in 2024-2026 (news-release sourced) are absent from it, so they never
 * reach way-tags.json — they neither affect routing nor surface in the OSM
 * backlog. This script lets us inject them as a supplement source that flows
 * through the EXISTING spatial join (see the merge in build-graph.ts).
 *
 * APPROACH (no hand-drawn bboxes): each manifest row names a street plus the
 * authoritative `from`/`to` cross-streets from the PBOT project page. We find
 * where the named street meets each cross-street in the LOCAL OSM data (shared
 * vertices — OSM ways split at intersections), derive a tight clip bbox from
 * those two intersection points, and emit every matching OSM way segment inside
 * it as a feature carrying `properties.class` (PBOT vocabulary). Quadrant-
 * prefixed OSM names ("Southeast Washington Street") already disambiguate by
 * quadrant, so name + intersection-derived bbox is precise.
 *
 * READS:
 *   data/pbot-supplement/new-builds.manifest.json
 *   data/reconciled/current/osm-ways.geojson   (produced by build-graph.ts)
 *
 * WRITES:
 *   data/pbot-supplement/new-builds.geojson     (PBOT-style FeatureCollection)
 *
 * USAGE:
 *   npm run build:supplement
 *   npm run build:supplement -- --inspect "Southeast Washington Street"
 *       # dump the lat/lng extent of a street name in OSM to debug a row
 *
 * EXIT CODES:
 *   0  wrote new-builds.geojson (warnings are non-fatal; unresolved rows skipped)
 *   2  manifest or osm-ways.geojson missing
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "node:url";
import * as turf from "@turf/turf";
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
} from "geojson";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SUPPLEMENT_DIR = path.join(REPO_ROOT, "data", "pbot-supplement");
const MANIFEST_PATH = path.join(SUPPLEMENT_DIR, "new-builds.manifest.json");
const OSM_WAYS_PATH = path.join(
  REPO_ROOT,
  "data",
  "reconciled",
  "current",
  "osm-ways.geojson"
);
const OUT_PATH = path.join(SUPPLEMENT_DIR, "new-builds.geojson");

/** Intersection-node coordinate match tolerance (degrees, ~1cm). OSM ways that
 *  cross share the SAME node, so coordinates are byte-identical; epsilon only
 *  guards float re-serialisation. */
const SHARED_NODE_EPS = 1e-7;

/** Padding added around the from/to intersection bbox (degrees, ~15m) so the
 *  clip includes ways whose vertices sit just outside the exact corner. */
const BBOX_PAD_DEG = 1.5e-4;

// PBOT `class` vocabulary accepted by build-graph.ts CLASS_MAP. The manifest
// must use one of these raw values (NOT the normalized class, e.g. use "lane"
// for a standard bike lane, which build-graph normalizes to "standard").
const VALID_CLASSES = new Set([
  "greenway",
  "protected",
  "buffered",
  "lane",
  "shared",
  "path",
]);

interface ManifestRow {
  id: string;
  name: string;
  class: string;
  from: string;
  to: string;
  /** optional explicit bbox [w,s,e,n] override when cross-streets don't resolve */
  bbox?: [number, number, number, number];
  /** optional — two-way tracks on a one-way street */
  oneway_bicycle?: string;
  /** optional — concrete-hardening upgrades */
  separation?: string;
  /** optional human-readable description; falls back to a composed note */
  note?: string;
  source_url: string;
  completed: string;
}

/** A reader-facing one-liner for the app's "learn more about network" panel. */
function buildNote(row: ManifestRow): string {
  const CLASS_LABEL: Record<string, string> = {
    greenway: "neighborhood greenway",
    protected: "protected bike lane",
    buffered: "buffered bike lane",
    lane: "bike lane",
    path: "off-street path",
  };
  const facility = CLASS_LABEL[row.class] ?? row.class;
  const year = row.completed?.slice(0, 4);
  const base = `New ${facility} on ${row.name} (${row.from}–${row.to})${
    year ? `, opened ${year}` : ""
  }. Built by PBOT; not yet in the published bike map.`;
  // Prefer the curator's note when it adds detail beyond the composed sentence.
  return row.note ? `${base} ${row.note}` : base;
}

type LineFeature = Feature<LineString | MultiLineString>;

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}

function fail(msg: string): never {
  console.error(`\n[ERROR] ${msg}\n`);
  process.exit(2);
}

function loadFC(p: string): FeatureCollection {
  return JSON.parse(fs.readFileSync(p, "utf8")) as FeatureCollection;
}

/** All vertices of a Line/MultiLine feature as [lng,lat] pairs. */
function vertices(f: LineFeature): Array<[number, number]> {
  const g = f.geometry;
  if (g.type === "LineString") return g.coordinates as Array<[number, number]>;
  return (g.coordinates as Array<Array<[number, number]>>).flat();
}

/** Find the coordinate where any `mainWays` vertex coincides with any vertex of
 *  a way named `crossName`. Returns the shared node, or null if none. */
function intersectionPoint(
  mainWays: LineFeature[],
  crossName: string,
  byName: Map<string, LineFeature[]>
): [number, number] | null {
  const crossWays = byName.get(norm(crossName));
  if (!crossWays || crossWays.length === 0) return null;

  // Index main-street vertices for O(1)-ish lookup with epsilon snapping.
  const key = (c: [number, number]) =>
    `${Math.round(c[0] / SHARED_NODE_EPS)}:${Math.round(c[1] / SHARED_NODE_EPS)}`;
  const mainVerts = new Map<string, [number, number]>();
  for (const w of mainWays) for (const c of vertices(w)) mainVerts.set(key(c), c);

  for (const cw of crossWays) {
    for (const c of vertices(cw)) {
      const hit = mainVerts.get(key(c));
      if (hit) return hit;
    }
  }
  return null;
}

function inspect(name: string, byName: Map<string, LineFeature[]>): void {
  const ways = byName.get(norm(name));
  if (!ways || ways.length === 0) {
    console.log(`No OSM ways named "${name}".`);
    return;
  }
  const fc: FeatureCollection = { type: "FeatureCollection", features: ways };
  const bb = turf.bbox(fc);
  console.log(`"${name}": ${ways.length} ways`);
  console.log(`  bbox [w,s,e,n] = [${bb.map((n) => n.toFixed(6)).join(", ")}]`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (!fs.existsSync(OSM_WAYS_PATH)) {
    fail(
      `Missing ${path.relative(REPO_ROOT, OSM_WAYS_PATH)}.\n` +
        `        Run: npm run build:graph  (it exports OSM ways) first.`
    );
  }

  console.log(`[load]   OSM ways…`);
  const osm = loadFC(OSM_WAYS_PATH);
  const byName = new Map<string, LineFeature[]>();
  for (const f of osm.features) {
    const g = f.geometry;
    if (!g || (g.type !== "LineString" && g.type !== "MultiLineString")) continue;
    const nm = f.properties?.name;
    if (typeof nm !== "string") continue;
    const k = norm(nm);
    const arr = byName.get(k) ?? [];
    arr.push(f as LineFeature);
    byName.set(k, arr);
  }
  console.log(`         ${osm.features.length} ways, ${byName.size} distinct names`);

  // --inspect "<name>" — debug helper for authoring the manifest.
  const inspectIdx = args.indexOf("--inspect");
  if (inspectIdx !== -1) {
    inspect(args[inspectIdx + 1] ?? "", byName);
    return;
  }

  if (!fs.existsSync(MANIFEST_PATH)) {
    fail(`Missing manifest ${path.relative(REPO_ROOT, MANIFEST_PATH)}.`);
  }
  const rows = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8")) as ManifestRow[];
  console.log(`[load]   ${rows.length} manifest rows`);

  const out: LineFeature[] = [];
  let skipped = 0;

  for (const row of rows) {
    if (!VALID_CLASSES.has(row.class)) {
      console.log(`[WARN]   ${row.id}: class "${row.class}" not in PBOT vocabulary — skipping`);
      skipped++;
      continue;
    }
    const mainWays = byName.get(norm(row.name));
    if (!mainWays || mainWays.length === 0) {
      console.log(`[WARN]   ${row.id}: no OSM ways named "${row.name}" — skipping`);
      skipped++;
      continue;
    }

    // Derive the clip bbox: explicit override, else from the two intersections.
    let bbox = row.bbox;
    if (!bbox) {
      const a = intersectionPoint(mainWays, row.from, byName);
      const b = intersectionPoint(mainWays, row.to, byName);
      if (!a || !b) {
        const which = [!a && `from "${row.from}"`, !b && `to "${row.to}"`]
          .filter(Boolean)
          .join(" & ");
        console.log(
          `[WARN]   ${row.id}: could not locate ${which} on "${row.name}". ` +
            `Add an explicit "bbox" override to the manifest row. Skipping.`
        );
        skipped++;
        continue;
      }
      bbox = [
        Math.min(a[0], b[0]) - BBOX_PAD_DEG,
        Math.min(a[1], b[1]) - BBOX_PAD_DEG,
        Math.max(a[0], b[0]) + BBOX_PAD_DEG,
        Math.max(a[1], b[1]) + BBOX_PAD_DEG,
      ];
    }

    // Keep main-street ways whose midpoint falls inside the clip bbox.
    const [w, s, e, n] = bbox;
    const inside = (c: [number, number]) =>
      c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n;
    const kept = mainWays.filter((way) => {
      const vs = vertices(way);
      const mid = vs[Math.floor(vs.length / 2)];
      return mid && inside(mid);
    });

    if (kept.length === 0) {
      console.log(`[WARN]   ${row.id}: 0 ways inside clip — check from/to. Skipping.`);
      skipped++;
      continue;
    }

    for (const way of kept) {
      const props: Record<string, unknown> = {
        class: row.class,
        name: row.name,
        supplement_id: row.id,
        build_note: buildNote(row),
        source_url: row.source_url,
        completed: row.completed,
      };
      if (row.oneway_bicycle) props.oneway_bicycle = row.oneway_bicycle;
      if (row.separation) props.separation = row.separation;
      out.push({ type: "Feature", properties: props, geometry: way.geometry });
    }
    console.log(`[ok]     ${row.id}: ${kept.length} ways (${row.class})`);
  }

  const fc: FeatureCollection = { type: "FeatureCollection", features: out };
  fs.mkdirSync(SUPPLEMENT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify(fc) + "\n", "utf8");
  console.log(
    `\n[write]  ${path.relative(REPO_ROOT, OUT_PATH)} — ` +
      `${out.length} features from ${rows.length - skipped}/${rows.length} rows` +
      (skipped ? ` (${skipped} skipped — see warnings)` : "")
  );
}

main();
