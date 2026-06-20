/**
 * check-data-sync.ts — guard the multi-target shared GeoJSON exports.
 *
 * Each `export:*` script writes the SAME GeoJSON to several places at once so
 * the web overlay, the bundled iOS copy, and (for bike-network) the server's
 * runtime copy stay identical:
 *
 *   bike-network.geojson → web/public · ios/.../Resources · server/data
 *   greenways.geojson     → web/public · ios/.../Resources
 *   arterials.geojson     → web/public · ios/.../Resources
 *
 * A partial export run, or a hand-edit of one copy, silently desyncs the
 * others (most often the bundled iOS copy goes stale). This script byte-hashes
 * each group and fails (exit 1) if any target is missing or differs, naming the
 * `export:*` script to re-run.
 *
 * USAGE:  tsx scripts/check-data-sync.ts   (or: npm run check)
 * EXIT:   0 all groups in sync · 1 a target is missing or diverged
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const WEB = path.join(REPO_ROOT, "web", "public");
const IOS = path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources");
const SERVER = path.join(REPO_ROOT, "server", "data");

interface Group {
  file: string;
  script: string;
  targets: string[];
}

const GROUPS: Group[] = [
  {
    file: "bike-network.geojson",
    script: "npm run export:bike-network",
    targets: [WEB, IOS, SERVER],
  },
  {
    file: "greenways.geojson",
    script: "npm run export:greenways",
    targets: [WEB, IOS],
  },
  {
    file: "arterials.geojson",
    script: "npm run export:arterials",
    targets: [WEB, IOS],
  },
];

function sha256(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

const errors: string[] = [];

for (const { file, script, targets } of GROUPS) {
  const paths = targets.map((dir) => path.join(dir, file));
  const missing = paths.filter((p) => !fs.existsSync(p));
  if (missing.length) {
    for (const p of missing) {
      errors.push(`${file}: missing at ${path.relative(REPO_ROOT, p)}`);
    }
    errors.push(`  → re-run \`${script}\` to regenerate all copies of ${file}`);
    continue;
  }
  const hashes = paths.map((p) => ({ p, h: sha256(p) }));
  const distinct = new Set(hashes.map((x) => x.h));
  if (distinct.size > 1) {
    errors.push(`${file}: copies DIVERGE between targets —`);
    for (const { p, h } of hashes) {
      errors.push(`     ${h.slice(0, 12)}  ${path.relative(REPO_ROOT, p)}`);
    }
    errors.push(`  → re-run \`${script}\` to rewrite every copy from source`);
  }
}

if (errors.length) {
  console.error("✗ shared GeoJSON data-sync check FAILED:\n");
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}

console.log(
  `✓ shared GeoJSON in sync across targets (${GROUPS.length} files: ${GROUPS.map((g) => g.file).join(", ")})`,
);
