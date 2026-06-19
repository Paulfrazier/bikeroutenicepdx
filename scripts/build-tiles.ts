/**
 * build-tiles.ts
 *
 * Builds the self-hosted vector basemap (PMTiles) the web app expects at
 * web/public/portland.pmtiles. Runs Planetiler's built-in OpenMapTiles
 * profile over the cropped Portland OSM PBF produced by `npm run fetch:osm`.
 *
 * The OpenMapTiles schema emits exactly the source-layers the web style in
 * web/src/components/Map.tsx reads: water, landuse, transportation,
 * transportation_name, building, place.
 *
 * READS:  data/osm/current/portland.osm.pbf  (from `npm run fetch:osm`)
 * WRITES: web/public/portland.pmtiles
 *         data/sources/                       (Planetiler scratch — natural earth, water polygons)
 *
 * EXTERNAL DEPS:
 *   java 21+        — brew install openjdk
 *   tools/planetiler.jar — downloaded from
 *     https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar
 *   (this script auto-downloads the jar if it is missing)
 *
 * USAGE:
 *   npm run build:tiles
 *   npm run build:tiles -- --force   # rebuild even if portland.pmtiles exists
 *
 * EXIT CODES:
 *   0  success
 *   1  runtime error (missing PBF, planetiler failed, download failed)
 *   2  config error — java not found on PATH
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PLANETILER_JAR_URL =
  "https://github.com/onthegomap/planetiler/releases/latest/download/planetiler.jar";

/** Memory cap for the JVM. The Portland crop is small; 2g is ample. */
const JVM_MAX_HEAP = "2g";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PBF_PATH = path.join(REPO_ROOT, "data", "osm", "current", "portland.osm.pbf");
const JAR_PATH = path.join(REPO_ROOT, "tools", "planetiler.jar");
const SOURCES_DIR = path.join(REPO_ROOT, "data", "sources");
const OUTPUT_PATH = path.join(REPO_ROOT, "web", "public", "portland.pmtiles");

const force = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function checkJava(): void {
  const result = spawnSync("java", ["-version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    console.error(
      `\n[ERROR] java is not installed or not on PATH.\n\n` +
        `        Install it with:\n` +
        `          brew install openjdk\n` +
        `          export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"\n\n` +
        `        Planetiler needs Java 21 or newer.\n`
    );
    process.exit(2);
  }
  const version = (result.stderr || result.stdout || "").split("\n")[0].trim();
  console.log(`[java]     ${version}`);
}

function checkPbf(): void {
  if (!fs.existsSync(PBF_PATH)) {
    console.error(
      `\n[ERROR] Portland OSM PBF not found at:\n` +
        `          ${PBF_PATH}\n\n` +
        `        Run the OSM fetch step first:\n` +
        `          npm run fetch:osm\n`
    );
    process.exit(1);
  }
  const mb = (fs.statSync(PBF_PATH).size / (1024 * 1024)).toFixed(1);
  console.log(`[pbf]      ${PBF_PATH} (${mb} MB)`);
}

function ensureJar(): void {
  if (fs.existsSync(JAR_PATH)) {
    const mb = (fs.statSync(JAR_PATH).size / (1024 * 1024)).toFixed(1);
    console.log(`[jar]      ${JAR_PATH} (${mb} MB)`);
    return;
  }
  console.log(`[jar]      downloading planetiler.jar …`);
  fs.mkdirSync(path.dirname(JAR_PATH), { recursive: true });
  const result = spawnSync(
    "curl",
    ["-fSL", "-o", JAR_PATH, PLANETILER_JAR_URL],
    { stdio: "inherit" }
  );
  if (result.status !== 0 || !fs.existsSync(JAR_PATH)) {
    console.error(`\n[ERROR] Failed to download planetiler.jar from ${PLANETILER_JAR_URL}\n`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

function build(): void {
  if (fs.existsSync(OUTPUT_PATH) && !force) {
    console.error(
      `\n[ERROR] ${OUTPUT_PATH} already exists.\n` +
        `        Re-run with --force to rebuild:\n` +
        `          npm run build:tiles -- --force\n`
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.mkdirSync(SOURCES_DIR, { recursive: true });

  const args = [
    `-Xmx${JVM_MAX_HEAP}`,
    "-jar",
    JAR_PATH,
    // Built-in OpenMapTiles profile (default), reading our cropped PBF.
    `--osm-path=${PBF_PATH}`,
    `--output=${OUTPUT_PATH}`,
    `--download-dir=${SOURCES_DIR}`,
    // Fetch the small ancillary sources (water polygons, natural earth) once.
    "--download",
    "--force",
  ];

  console.log(`[build]    planetiler → ${OUTPUT_PATH}`);
  const result = spawnSync("java", args, { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\n[ERROR] planetiler exited with status ${result.status}\n`);
    process.exit(1);
  }

  const mb = (fs.statSync(OUTPUT_PATH).size / (1024 * 1024)).toFixed(1);
  console.log(`\nDone. Basemap PMTiles at: ${OUTPUT_PATH} (${mb} MB)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

checkJava();
checkPbf();
ensureJar();
build();
