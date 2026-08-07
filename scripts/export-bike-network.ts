/**
 * export-bike-network.ts
 *
 * Produces the bike-map overlay GeoJSON for the front-ends: every facility
 * segment published by the agencies in scripts/lib/jurisdictions.ts, normalized
 * to one `class` vocabulary so the map can color greenways, protected lanes and
 * bike-friendly streets identically no matter who published them.
 *
 * SOURCES: see scripts/lib/jurisdictions.ts — that registry is the only place
 *   agency URLs, facility-code vocabularies and license strings live. Phase 1 is
 *   City of Portland (PBOT) + Metro RLIS (the whole Oregon metro).
 *
 * WRITES:
 *   bike-network.geojson        merged view of every jurisdiction — the file all
 *                               three clients and scripts/build-graph.ts read.
 *                               → web/public, ios Resources, server/data
 *   bike-network.manifest.json  { id, file, bbox, features, bytes, fetchedAt,
 *                                 attribution, attributionUrl }[] — drives the
 *                               credits UI on web + iOS.
 *                               → web/public, ios Resources, server/data
 *   bike-network.<id>.geojson   one file per jurisdiction, WEB ONLY. Same
 *                               features as the merged file, so shipping them to
 *                               iOS too would double the app bundle for files
 *                               nothing there opens. They exist for viewport-
 *                               scoped lazy loading (not yet wired up).
 *
 * Each feature: { type:"Feature", geometry:LineString|MultiLineString,
 *                 properties:{ class, rclass, facility, name?, source, stress? } }
 *   class    — normalized display category, drives color
 *   rclass   — render class after the speed/stroad down-rate (see lib/render-class)
 *   facility — the agency's raw code (PBL/BBL/NG/SR_LT/BKE-BLVD/…)
 *   source   — jurisdiction id, so provenance is debuggable in the field
 *   stress   — normalized traffic stress where the agency publishes one (RLIS)
 *
 * The manifest's `fetchedAt` is what the clients render next to Metro's
 * attribution — Metro's license requires the date the data was received.
 *
 * EXTERNAL DEPS: none (Node built-ins: fs, path, fetch)
 * USAGE:  npm run export:bike-network
 * EXIT CODES: 0 wrote every target · 1 fetch failed / a jurisdiction came back empty
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { bakeRenderClass, MIN_FAST_MPH, MIN_STROAD_LANES } from "./lib/render-class.js";
import {
  JURISDICTIONS,
  type DisplayClass,
  type Jurisdiction,
  type SourceSpec,
} from "./lib/jurisdictions.js";
import { contains, loadCityBoundary, representativePoint, type Boundary } from "./lib/boundary.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const COORD_PRECISION = 6;

const WEB_DIR = path.join(REPO_ROOT, "web", "public");
const IOS_DIR = path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources");
const SERVER_DIR = path.join(REPO_ROOT, "server", "data");

/** Surfaces that read the merged network + the manifest: web fetches them at
 * runtime, iOS bundles them into the app, the server reads them per-process. */
const TARGET_DIRS = [WEB_DIR, IOS_DIR, SERVER_DIR];

/**
 * Per-jurisdiction layers go to web only, on purpose.
 *
 * They hold exactly the same features as the merged bike-network.geojson, so
 * shipping both to iOS doubles the app bundle (~9 MB of duplication) for files
 * nothing on that platform opens — iOS reads the merged file and the manifest.
 * The server likewise only ever loads the merged view.
 *
 * Web keeps them because they're the artifact viewport-scoped lazy loading will
 * consume: the manifest's per-jurisdiction bbox lets the client fetch only the
 * regions a route or viewport actually touches, instead of the whole metro. That
 * is not wired up yet — web still eagerly loads the merged file.
 */
const PARTS_DIRS = [WEB_DIR];

const BOUNDARY_CACHE = path.join(REPO_ROOT, "data", "boundaries");

// Hand-curated PBOT facilities built but not yet in the published GIS — produced
// by `npm run build:supplement` (see data/pbot-supplement/ + docs/data-sources.md).
const SUPPLEMENT_PATH = path.join(REPO_ROOT, "data", "pbot-supplement", "new-builds.geojson");
const SUPPLEMENT_FACILITY: Record<string, string> = {
  greenway: "NG",
  protected: "PBL",
  buffered: "BBL",
  lane: "BL",
  path: "TRL",
};

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

interface ManifestEntry {
  id: string;
  file: string;
  bbox: [number, number, number, number];
  features: number;
  bytes: number;
  fetchedAt: string;
  attribution: string;
  attributionUrl: string;
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
  name: unknown,
  sourceId: string,
  stress: string | undefined
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
      ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
      source: sourceId,
      ...(stress ? { stress } : {}),
    },
  };
}

/** Classify one raw feature using a source's own code vocabulary. */
function makeTrimmer(spec: SourceSpec, sourceId: string) {
  return (feature: GeoJSONFeature): GeoJSONFeature | null => {
    const code = String(feature.properties?.[spec.codeField] ?? "").trim();
    const cls = spec.classMap[code];
    if (!cls) return null; // unrecognized / not a ridable facility
    const stressRaw = spec.stressField
      ? String(feature.properties?.[spec.stressField] ?? "").trim()
      : "";
    const stress = stressRaw && spec.stressMap ? spec.stressMap[stressRaw] : undefined;
    const name = spec.nameField ? feature.properties?.[spec.nameField] : undefined;
    return buildFeature(feature, cls, code, name, sourceId, stress);
  };
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
  spec: SourceSpec,
  sourceId: string,
  kept: GeoJSONFeature[],
  byClass: Record<string, number>
): Promise<number> {
  const trimFn = makeTrimmer(spec, sourceId);
  let offset = 0;
  let raw = 0;
  for (;;) {
    const fc = await fetchPage({ ...spec, offset });
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
    process.stdout.write(`\r[${spec.label}] offset ${offset} → ${raw} raw / ${kept.length} kept`);
    if (page.length < spec.pageSize && !fc.exceededTransferLimit) break;
    offset += spec.pageSize;
  }
  process.stdout.write("\n");
  return raw;
}

/**
 * Append the built-but-unpublished supplement facilities. Each carries
 * `rclass = class` (no speed downgrade — these are new, good facilities), the
 * matching facility code, and a `build_note`/`source_url`/`completed` for the
 * app's "learn more about network" panel. `supplement: true` marks provenance.
 * No-op if the supplement file is absent.
 */
function mergeSupplement(kept: GeoJSONFeature[]): void {
  if (!fs.existsSync(SUPPLEMENT_PATH)) {
    console.warn(
      `[supplement] WARN: ${path.relative(REPO_ROOT, SUPPLEMENT_PATH)} not found — run build:supplement. Skipping.`
    );
    return;
  }
  const fc = JSON.parse(fs.readFileSync(SUPPLEMENT_PATH, "utf8")) as FeatureCollection;
  let added = 0;
  for (const f of fc.features) {
    if (!f.geometry) continue;
    const t = f.geometry.type;
    if (t !== "LineString" && t !== "MultiLineString") continue;
    const cls = String(f.properties?.["class"] ?? "");
    kept.push({
      type: "Feature",
      geometry: { type: t, coordinates: roundCoords(f.geometry.coordinates) },
      properties: {
        class: cls,
        rclass: cls,
        facility: SUPPLEMENT_FACILITY[cls] ?? "",
        ...(f.properties?.["name"] ? { name: f.properties["name"] } : {}),
        source: "portland",
        supplement: true,
        build_note: f.properties?.["build_note"] ?? "",
        source_url: f.properties?.["source_url"] ?? "",
        completed: f.properties?.["completed"] ?? "",
      },
    });
    added++;
  }
  console.log(`[supplement] merged ${added} built-but-unpublished features`);
}

function bboxOf(features: GeoJSONFeature[]): [number, number, number, number] {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  const visit = (c: unknown): void => {
    if (!Array.isArray(c)) return;
    if (typeof c[0] === "number" && typeof c[1] === "number") {
      const lon = c[0] as number;
      const lat = c[1] as number;
      if (lon < minLon) minLon = lon;
      if (lat < minLat) minLat = lat;
      if (lon > maxLon) maxLon = lon;
      if (lat > maxLat) maxLat = lat;
      return;
    }
    for (const x of c) visit(x);
  };
  for (const f of features) if (f.geometry) visit(f.geometry.coordinates);
  return [round(minLon), round(minLat), round(maxLon), round(maxLat)];
}

function write(name: string, json: string, dirs: string[]): void {
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), json, "utf8");
  }
  console.log(
    `[OK]    wrote ${(json.length / 1024).toFixed(1)} KB → ${name} (${dirs.length} target${dirs.length === 1 ? "" : "s"})`
  );
}

/**
 * Bake `rclass` for one jurisdiction.
 *
 * Portland joins against the PBOT posted-speed + arterial exports, which only
 * cover the city. Outside it those joins have no data, so an RLIS lane would
 * always keep rclass = class and never read as stressful. RLIS publishes its own
 * `BIKETHERE` traffic-stress rating, so we use it as the fallback signal: an
 * unprotected facility on a high-traffic or caution-rated segment gets the same
 * down-rate the speed join would have applied in town. Separated facilities
 * (protected/greenway/path) are never down-rated, matching render-class.ts.
 */
function bakeStressFallback(features: GeoJSONFeature[]): { busy: number; caution: number } {
  const STRONG = new Set(["protected", "greenway", "path", "calm", "calm_mod"]);
  let busy = 0;
  let caution = 0;
  for (const f of features) {
    const p = f.properties;
    if (!p) continue;
    const cls = String(p["class"]);
    if (p["rclass"]) continue; // already baked
    if (STRONG.has(cls)) {
      p["rclass"] = cls;
      continue;
    }
    const stress = p["stress"];
    if (stress === "high") {
      p["rclass"] = "busy";
      busy++;
    } else if (stress === "caution") {
      p["rclass"] = "caution";
      caution++;
    } else {
      p["rclass"] = cls;
    }
  }
  return { busy, caution };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fetchedAt = new Date().toISOString().slice(0, 10);
  const manifest: ManifestEntry[] = [];
  const merged: GeoJSONFeature[] = [];

  // The Portland clip is a correctness guard (keeps PBOT + the new-builds
  // supplement authoritative in-city), so a failure here is fatal rather than a
  // warning we ride past — skipping it would let staler RLIS geometry silently
  // down-class the hand-curated 2024–26 lanes.
  let portlandBoundary: Boundary | null = null;
  if (JURISDICTIONS.some((j) => j.clipOutsideOf === "portland")) {
    portlandBoundary = await loadCityBoundary("Portland", BOUNDARY_CACHE);
    console.log(`[clip] Portland boundary: ${portlandBoundary.rings.length} rings`);
  }

  for (const j of JURISDICTIONS) {
    console.log(`\n=== ${j.id} — ${j.label} ===`);
    const kept: GeoJSONFeature[] = [];
    const byClass: Record<string, number> = {};

    for (const spec of j.sources) {
      console.log(`[source] ${spec.label}\n         ${spec.url}`);
      await collect(spec, j.id, kept, byClass);
    }

    if (kept.length === 0) {
      console.error(`[ERROR] ${j.id} produced 0 features — aborting (won't ship an empty layer)`);
      process.exit(1);
    }

    // Precedence: drop anything inside the city PBOT already covers.
    let clipped = kept;
    if (j.clipOutsideOf === "portland" && portlandBoundary) {
      clipped = kept.filter((f) => {
        if (!f.geometry) return false;
        const pt = representativePoint(f.geometry);
        if (!pt) return false;
        return !contains(portlandBoundary!, pt[0], pt[1]);
      });
      console.log(
        `[clip] ${j.id}: dropped ${kept.length - clipped.length} features inside Portland, kept ${clipped.length}`
      );
      if (clipped.length === 0) {
        console.error(`[ERROR] ${j.id} clipped to 0 features — boundary is probably wrong`);
        process.exit(1);
      }
    }

    // rclass: PBOT speed/arterial join in town, RLIS stress rating outside it.
    if (j.id === "portland") {
      const speedsPath = path.join(REPO_ROOT, "web", "public", "speeds.geojson");
      if (fs.existsSync(speedsPath)) {
        const speeds = JSON.parse(fs.readFileSync(speedsPath, "utf8"));
        const arterialsPath = path.join(REPO_ROOT, "web", "public", "arterials.geojson");
        const arterials = fs.existsSync(arterialsPath)
          ? JSON.parse(fs.readFileSync(arterialsPath, "utf8"))
          : undefined;
        if (!arterials) {
          console.warn(
            `[rclass] WARN: ${path.relative(REPO_ROOT, arterialsPath)} not found — run export:arterials. Skipping the door-zone-lane-on-arterial down-rate.`
          );
        }
        const { busy, caution, caution4 } = bakeRenderClass(
          clipped,
          speeds,
          MIN_FAST_MPH,
          arterials
        );
        console.log(
          `[rclass] ${busy} on ≥${MIN_FAST_MPH} mph → "busy"; lane on arterial → caution ${caution} (2–3 lanes) · caution4 ${caution4} (≥${MIN_STROAD_LANES} lanes, red)`
        );
      } else {
        console.warn(
          `[rclass] WARN: ${path.relative(REPO_ROOT, speedsPath)} not found — run export:speeds, then bake:render-class. Writing without downgrade.`
        );
        for (const f of clipped) if (f.properties) f.properties["rclass"] = f.properties["class"];
      }
      // AFTER the bake so the new facilities keep rclass = class.
      mergeSupplement(clipped);
    } else {
      const { busy, caution } = bakeStressFallback(clipped);
      console.log(`[rclass] stress fallback → busy ${busy} (BIKETHERE=HT) · caution ${caution} (CA)`);
    }

    console.log(`[classes] ${JSON.stringify(byClass)}`);

    const file = `bike-network.${j.id}.geojson`;
    const json = JSON.stringify({ type: "FeatureCollection", features: clipped });
    write(file, json, PARTS_DIRS);
    manifest.push({
      id: j.id,
      file,
      bbox: bboxOf(clipped),
      features: clipped.length,
      bytes: json.length,
      fetchedAt,
      attribution: j.attribution,
      attributionUrl: j.attributionUrl,
    });
    merged.push(...clipped);
  }

  write("bike-network.manifest.json", JSON.stringify(manifest, null, 2), TARGET_DIRS);

  // Backward-compatible merged file: scripts/build-graph.ts and any loader not
  // yet manifest-aware still read this. Keeping it means the metro expansion
  // can't break routing tile builds on a stale checkout.
  write("bike-network.geojson", JSON.stringify({ type: "FeatureCollection", features: merged }), TARGET_DIRS);

  console.log(
    `\nDone — ${merged.length} features across ${manifest.length} jurisdictions:\n` +
      manifest
        .map((m) => `  ${m.id.padEnd(10)} ${String(m.features).padStart(6)} features  ${(m.bytes / 1024 / 1024).toFixed(2)} MB`)
        .join("\n")
  );
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
