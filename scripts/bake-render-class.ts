/**
 * bake-render-class.ts — re-bake the `rclass` property onto the existing
 * bike-network.geojson copies WITHOUT re-fetching from PortlandMaps.
 *
 * Reads the committed web/public/bike-network.geojson + web/public/speeds.geojson,
 * joins them (see lib/render-class.ts), and rewrites all three target copies
 * (web / iOS / server) so they stay byte-identical (check-data-sync).
 *
 * export-bike-network.ts bakes rclass too, so a fresh fetch already includes it;
 * this CLI is for re-baking after a threshold change or a speeds refresh without
 * a network round-trip.
 *
 * USAGE:  npm run bake:render-class
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { bakeRenderClass, MIN_FAST_MPH, MIN_STROAD_LANES, type FeatureLike, type FCLike } from "./lib/render-class.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const BIKE = path.join(REPO_ROOT, "web", "public", "bike-network.geojson");
const SPEEDS = path.join(REPO_ROOT, "web", "public", "speeds.geojson");
const ARTERIALS = path.join(REPO_ROOT, "web", "public", "arterials.geojson");
const TARGETS = [
  BIKE,
  path.join(REPO_ROOT, "ios", "BikeRouteNicePDX", "Resources", "bike-network.geojson"),
  path.join(REPO_ROOT, "server", "data", "bike-network.geojson"),
];

function read(file: string): { features?: FeatureLike[] } & FCLike {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function main(): void {
  const bike = read(BIKE);
  const speeds = read(SPEEDS);
  if (!bike.features?.length) throw new Error(`no features in ${BIKE}`);
  const arterials = fs.existsSync(ARTERIALS) ? read(ARTERIALS) : undefined;
  if (!arterials) {
    console.warn(
      `[bake] WARN: ${path.relative(REPO_ROOT, ARTERIALS)} not found — run export:arterials. Skipping the door-zone-lane-on-arterial down-rate.`
    );
  }

  const { downgraded, downgradedArterial, downgradedWide, total } = bakeRenderClass(
    bike.features,
    speeds,
    MIN_FAST_MPH,
    arterials
  );
  console.log(
    `[bake] rclass on ${total} features — ${downgraded} unprotected lanes on ≥${MIN_FAST_MPH} mph streets → "busy"; ${downgradedArterial} plain unbuffered lanes on arterials + ${downgradedWide} unprotected facilities on ≥${MIN_STROAD_LANES}-lane stroads → "caution"`
  );

  const json = JSON.stringify(bike);
  for (const t of TARGETS) {
    fs.writeFileSync(t, json, "utf8");
    console.log(`[OK]   ${(json.length / 1024).toFixed(1)} KB → ${path.relative(REPO_ROOT, t)}`);
  }
}

main();
