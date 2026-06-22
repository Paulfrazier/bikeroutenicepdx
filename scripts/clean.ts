/**
 * clean.ts — remove regenerable artifacts so the working tree stays small.
 *
 *   npm run clean        # cheap build caches (iOS builds, dist, tsbuildinfo,
 *                        # bake-off results) — safe, fast to rebuild.
 *   npm run clean -- --all   # also nuke fetched data + routing tiles. These
 *                        # take a network fetch + reconcile/tile build to
 *                        # regenerate (npm run fetch:* / reconcile / build:*).
 *
 * Everything here is gitignored and reproducible; nothing tracked is touched.
 */

import { rm, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Cheap to regenerate — always cleaned.
const BUILD_ARTIFACTS = [
  "ios/build",
  "ios/build-device",
  "ios/build-sim",
  "server/dist",
  "web/dist",
  "web/tsconfig.app.tsbuildinfo",
  "web/tsconfig.node.tsbuildinfo",
  "tests/results", // bake-off GeoJSON output
  "data/tmp",
];

// Expensive to regenerate (network fetch + reconcile + tile build) — only with --all.
const HEAVY_DATA = [
  "data/pbot",
  "data/osm",
  "data/reconciled",
  "data/sources",
  "routing/valhalla_tiles",
  "routing/valhalla_tiles.tar",
];

async function dirSize(path: string): Promise<number> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return s.size;
  } catch {
    return 0;
  }
  // Shell out to du for directory totals (fast, no recursion in JS).
  const { execFileSync } = await import("node:child_process");
  try {
    const out = execFileSync("du", ["-sk", path], { encoding: "utf8" });
    return parseInt(out.split("\t")[0], 10) * 1024;
  } catch {
    return 0;
  }
}

function human(bytes: number): string {
  if (bytes > 1e9) return (bytes / 1e9).toFixed(1) + "GB";
  if (bytes > 1e6) return (bytes / 1e6).toFixed(0) + "MB";
  if (bytes > 1e3) return (bytes / 1e3).toFixed(0) + "KB";
  return bytes + "B";
}

async function main(): Promise<void> {
  const all = process.argv.includes("--all");
  const targets = all ? [...BUILD_ARTIFACTS, ...HEAVY_DATA] : BUILD_ARTIFACTS;

  let freed = 0;
  for (const rel of targets) {
    const path = resolve(REPO_ROOT, rel);
    const size = await dirSize(path);
    if (size === 0) continue;
    await rm(path, { recursive: true, force: true });
    freed += size;
    console.log(`  removed ${rel}  (${human(size)})`);
  }

  console.log(
    freed > 0
      ? `\nFreed ${human(freed)}.${all ? " Re-run fetch:*/reconcile/build:tiles before the next graph build." : ""}`
      : "Nothing to clean."
  );
  if (!all) console.log("Tip: `npm run clean -- --all` also clears fetched data + routing tiles.");
}

main().catch((err) => {
  console.error("clean failed:", err);
  process.exit(1);
});
