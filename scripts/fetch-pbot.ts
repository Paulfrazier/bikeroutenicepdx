/**
 * fetch-pbot.ts
 *
 * Downloads PBOT bicycle network GIS layers from the Portland ArcGIS REST API
 * and saves them as GeoJSON to data/pbot/<YYYY-MM-DD>/.
 *
 * READS:  nothing (fresh HTTP fetches)
 * WRITES: data/pbot/<YYYY-MM-DD>/<layer>.geojson
 *         data/pbot/<YYYY-MM-DD>/manifest.json
 *         data/pbot/current  (symlink → dated folder)
 *
 * EXTERNAL DEPS: none (Node 22 built-in fetch)
 *
 * USAGE:
 *   npm run fetch:pbot
 *   npm run fetch:pbot -- --force   # re-fetch even if today's folder exists
 *
 * EXIT CODES:
 *   0  all layers fetched successfully
 *   1  some layers failed (at least one succeeded)
 *   1  all layers failed
 *
 * LAYER URLS:
 *   These come from the Portland ArcGIS Open Data portal:
 *   https://gis-pdx.opendata.arcgis.com/
 *
 *   If a URL stops working, search the portal for the layer name and update
 *   the `url` field in LAYERS below. The query suffix appended by this script
 *   follows the standard ArcGIS REST pattern:
 *     /query?where=1%3D1&outFields=*&f=geojson&outSR=4326
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Layer configuration
// ---------------------------------------------------------------------------

interface LayerConfig {
  /** Filesystem-safe name used as the output filename (no extension) */
  name: string;
  /** ArcGIS REST FeatureServer layer URL (without /query suffix) */
  url: string;
  /** Human description for logging and manifest */
  description: string;
}

/**
 * ArcGIS REST endpoint base for each PBOT layer.
 *
 * URL provenance:
 *   Bicycle Network:
 *     Portal: https://gis-pdx.opendata.arcgis.com/datasets/bicycle-network/
 *     FeatureServer: https://services.arcgis.com/quVN97tn06YNGj9s/arcgis/rest/services/Bicycle_Network/FeatureServer/0
 *
 *   Difficult Crossings:
 *     Portal: https://gis-pdx.opendata.arcgis.com/datasets/bicycle-difficult-crossings/
 *     FeatureServer: https://services.arcgis.com/quVN97tn06YNGj9s/arcgis/rest/services/Bicycle_Difficult_Crossings/FeatureServer/0
 *
 *   Wayfinding Signs:
 *     Portal: https://gis-pdx.opendata.arcgis.com/datasets/bicycle-wayfinding-signs/
 *     FeatureServer: https://services.arcgis.com/quVN97tn06YNGj9s/arcgis/rest/services/Bicycle_Wayfinding_Signs/FeatureServer/0
 *
 * NOTE: These URLs are best-effort. ArcGIS service IDs can change when PBOT
 * republishes layers. If you receive HTTP 4xx or an error JSON from ArcGIS,
 * go to the Open Data portal, click the layer, choose "I want to use this" →
 * "View API Resources" → copy the FeatureServer URL and update the entry here.
 */
const LAYERS: LayerConfig[] = [
  {
    name: "bicycle-network",
    url: "https://services.arcgis.com/quVN97tn06YNGj9s/arcgis/rest/services/Bicycle_Network/FeatureServer/0",
    description:
      "PBOT bicycle network lines with classification field (greenway, protected, buffered, standard, shared roadway, off-street path)",
  },
  {
    name: "difficult-crossings",
    url: "https://services.arcgis.com/quVN97tn06YNGj9s/arcgis/rest/services/Bicycle_Difficult_Crossings/FeatureServer/0",
    description:
      "PBOT difficult/dangerous crossing point features — used for +60s penalty in cost model",
  },
  {
    name: "wayfinding-signs",
    url: "https://services.arcgis.com/quVN97tn06YNGj9s/arcgis/rest/services/Bicycle_Wayfinding_Signs/FeatureServer/0",
    description:
      "PBOT bike wayfinding sign point features with destination text — used for v1.0 turn cues",
  },
];

// ArcGIS query parameters appended to every layer URL
const ARCGIS_QUERY_SUFFIX =
  "/query?where=1%3D1&outFields=*&f=geojson&outSR=4326";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_PBOT = path.join(REPO_ROOT, "data", "pbot");
const CURRENT_LINK = path.join(DATA_PBOT, "current");

function todayString(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchLayer(
  layer: LayerConfig,
  outDir: string
): Promise<{ success: boolean; byteCount: number; error?: string }> {
  const queryUrl = layer.url + ARCGIS_QUERY_SUFFIX;
  console.log(`\n[fetch] ${layer.name}`);
  console.log(`        ${queryUrl}`);

  let response: Response;
  try {
    response = await fetch(queryUrl, {
      headers: { Accept: "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] Network error fetching ${layer.name}: ${msg}`);
    return { success: false, byteCount: 0, error: msg };
  }

  if (!response.ok) {
    const msg = `HTTP ${response.status} ${response.statusText}`;
    console.error(`[ERROR] ${layer.name}: ${msg}`);
    return { success: false, byteCount: 0, error: msg };
  }

  let text: string;
  try {
    text = await response.text();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ERROR] Reading response body for ${layer.name}: ${msg}`);
    return { success: false, byteCount: 0, error: msg };
  }

  // Detect ArcGIS error JSON (200 OK but error in body)
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`[ERROR] ${layer.name}: response is not valid JSON`);
    return {
      success: false,
      byteCount: text.length,
      error: "Invalid JSON response",
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj["error"]) {
    const msg = JSON.stringify(obj["error"]);
    console.error(`[ERROR] ArcGIS error for ${layer.name}: ${msg}`);
    return { success: false, byteCount: text.length, error: msg };
  }

  // Pretty-print and save
  const prettyJson = JSON.stringify(parsed, null, 2);
  const outPath = path.join(outDir, `${layer.name}.geojson`);
  await fs.promises.writeFile(outPath, prettyJson, "utf8");

  const byteCount = Buffer.byteLength(prettyJson, "utf8");
  console.log(`[OK]    ${layer.name} → ${(byteCount / 1024).toFixed(1)} KB`);
  return { success: true, byteCount };
}

// ---------------------------------------------------------------------------
// Symlink helper
// ---------------------------------------------------------------------------

function updateCurrentSymlink(targetDir: string): void {
  // The symlink target should be relative so it works if the repo moves
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
  console.log(`\n[link]  data/pbot/current → ${relTarget}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const dateStr = todayString();
  const outDir = path.join(DATA_PBOT, dateStr);

  // Ensure base data/pbot directory exists
  await fs.promises.mkdir(DATA_PBOT, { recursive: true });

  // Idempotency check
  if (fs.existsSync(outDir) && !force) {
    console.log(
      `[skip]  ${outDir} already exists. Use --force to re-fetch.\n` +
        `        Updating symlink to existing folder.`
    );
    updateCurrentSymlink(outDir);
    process.exit(0);
  }

  await fs.promises.mkdir(outDir, { recursive: true });
  console.log(`\nFetching ${LAYERS.length} PBOT layers → ${outDir}\n`);

  const results: Array<{
    layer: LayerConfig;
    success: boolean;
    byteCount: number;
    error?: string;
    fetchedAt: string;
  }> = [];

  for (const layer of LAYERS) {
    const fetchedAt = new Date().toISOString();
    const result = await fetchLayer(layer, outDir);
    results.push({ layer, ...result, fetchedAt });
  }

  // Write manifest
  const manifest = {
    fetchedDate: dateStr,
    generatedAt: new Date().toISOString(),
    arcgisQuerySuffix: ARCGIS_QUERY_SUFFIX,
    layers: results.map((r) => ({
      name: r.layer.name,
      description: r.layer.description,
      url: r.layer.url + ARCGIS_QUERY_SUFFIX,
      success: r.success,
      byteCount: r.byteCount,
      fetchedAt: r.fetchedAt,
      ...(r.error ? { error: r.error } : {}),
    })),
  };

  const manifestPath = path.join(outDir, "manifest.json");
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`\n[manifest] written → ${manifestPath}`);

  // Summary
  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);
  console.log(
    `\nSummary: ${succeeded.length}/${results.length} layers fetched successfully`
  );
  if (failed.length > 0) {
    console.error(
      `Failed layers: ${failed.map((r) => r.layer.name).join(", ")}`
    );
  }

  if (succeeded.length > 0) {
    updateCurrentSymlink(outDir);
  }

  // Exit 1 if any layer failed (including all-failed)
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
