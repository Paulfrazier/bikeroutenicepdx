/**
 * fetch-osm.ts
 *
 * Downloads the Oregon OSM PBF extract from Geofabrik, crops it to the
 * Portland metro bounding box using osmium-tool, and saves the result to
 * data/osm/<YYYY-MM-DD>/portland.osm.pbf.
 *
 * READS:  nothing (fresh HTTP download)
 * WRITES: data/osm/<YYYY-MM-DD>/portland.osm.pbf
 *         data/osm/current  (symlink → dated folder)
 *
 * EXTERNAL DEPS:
 *   osmium-tool  (CLI)  — brew install osmium-tool
 *                         https://osmcode.org/osmium-tool/
 *
 * USAGE:
 *   npm run fetch:osm
 *   npm run fetch:osm -- --force   # re-download even if today's folder exists
 *
 * EXIT CODES:
 *   0  success
 *   1  runtime error (download failed, osmium extract failed)
 *   2  config error — osmium not found on PATH
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";
import { execFileSync, spawnSync } from "child_process";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Full Oregon PBF from Geofabrik (~200 MB download) */
const OREGON_PBF_URL =
  "https://download.geofabrik.de/north-america/us/oregon-latest.osm.pbf";

/**
 * Portland metro bounding box: lon_min, lat_min, lon_max, lat_max
 * Covers Portland city limits plus immediate suburbs.
 * Adjust if you need a tighter or looser crop.
 */
const PORTLAND_BBOX = "-123.0,45.3,-122.3,45.7";

/** How often to log download progress (every N bytes) */
const PROGRESS_INTERVAL_BYTES = 10 * 1024 * 1024; // 10 MB

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_OSM = path.join(REPO_ROOT, "data", "osm");
const CURRENT_LINK = path.join(DATA_OSM, "current");

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
// Download with streaming progress
// ---------------------------------------------------------------------------

async function downloadFile(url: string, destPath: string): Promise<void> {
  console.log(`\n[download] ${url}`);
  console.log(`           → ${destPath}`);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get("content-length");
  const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
  if (totalBytes) {
    console.log(`           ${(totalBytes / 1024 / 1024).toFixed(1)} MB total`);
  }

  if (!response.body) {
    throw new Error("Response has no body");
  }

  const writer = fs.createWriteStream(destPath);
  const reader = response.body.getReader();

  let downloaded = 0;
  let lastLoggedAt = 0;

  // Stream the response body to disk
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    await new Promise<void>((resolve, reject) => {
      writer.write(value, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    downloaded += value.byteLength;

    if (downloaded - lastLoggedAt >= PROGRESS_INTERVAL_BYTES) {
      lastLoggedAt = downloaded;
      const mb = (downloaded / 1024 / 1024).toFixed(1);
      const pct =
        totalBytes ? ` (${((downloaded / totalBytes) * 100).toFixed(0)}%)` : "";
      console.log(`           ${mb} MB downloaded${pct}`);
    }
  }

  await new Promise<void>((resolve, reject) => {
    writer.end((err: Error | null | undefined) => {
      if (err) reject(err);
      else resolve();
    });
  });

  const finalMb = (downloaded / 1024 / 1024).toFixed(1);
  console.log(`[OK]       ${finalMb} MB downloaded`);
}

// ---------------------------------------------------------------------------
// osmium extract
// ---------------------------------------------------------------------------

function osmiumExtract(
  inputPath: string,
  outputPath: string,
  bbox: string
): void {
  console.log(`\n[osmium]   extracting bbox ${bbox}`);
  console.log(`           ${inputPath}`);
  console.log(`           → ${outputPath}`);

  const result = spawnSync(
    "osmium",
    [
      "extract",
      "--bbox",
      bbox,
      inputPath,
      "--output",
      outputPath,
      "--overwrite",
    ],
    { stdio: "inherit" }
  );

  if (result.error) {
    throw new Error(`osmium spawn error: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`osmium extract exited with status ${result.status}`);
  }

  const stat = fs.statSync(outputPath);
  console.log(
    `[OK]       portland.osm.pbf — ${(stat.size / 1024 / 1024).toFixed(1)} MB`
  );
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
        `[WARN] ${CURRENT_LINK} exists but is not a symlink — skipping symlink update`
      );
      return;
    }
  }

  fs.symlinkSync(relTarget, CURRENT_LINK);
  console.log(`[link]     data/osm/current → ${relTarget}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const force = process.argv.includes("--force");

  // Check osmium first — exit 2 (config error) not 1 (runtime error)
  checkOsmium();

  const dateStr = todayString();
  const outDir = path.join(DATA_OSM, dateStr);
  const portlandPbf = path.join(outDir, "portland.osm.pbf");

  await fs.promises.mkdir(DATA_OSM, { recursive: true });

  // Idempotency check
  if (fs.existsSync(portlandPbf) && !force) {
    console.log(
      `\n[skip]  ${portlandPbf} already exists. Use --force to re-download.`
    );
    updateCurrentSymlink(outDir);
    process.exit(0);
  }

  await fs.promises.mkdir(outDir, { recursive: true });

  // Download to a temp file so we never leave a partial output PBF
  const tmpDir = os.tmpdir();
  const tmpPbf = path.join(tmpDir, `oregon-latest-${Date.now()}.osm.pbf`);

  try {
    await downloadFile(OREGON_PBF_URL, tmpPbf);

    osmiumExtract(tmpPbf, portlandPbf, PORTLAND_BBOX);
  } finally {
    // Always clean up the large Oregon-wide PBF
    if (fs.existsSync(tmpPbf)) {
      fs.unlinkSync(tmpPbf);
      console.log(`\n[cleanup]  deleted temp file ${path.basename(tmpPbf)}`);
    }
  }

  updateCurrentSymlink(outDir);
  console.log(`\nDone. Portland OSM PBF at: ${portlandPbf}`);
}

main().catch((err) => {
  console.error("\n[FATAL]", err instanceof Error ? err.message : err);
  process.exit(1);
});
