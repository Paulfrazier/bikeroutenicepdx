/**
 * check-parity.ts — guard the web ↔ iOS bike-friendliness classifier parity.
 *
 * The friendliness algorithm is duplicated in two hand-maintained files:
 *   web/src/friendliness.ts                       (TypeScript)
 *   ios/BikeRouteNicePDX/Services/BikeFriendliness.swift  (Swift)
 * Both files declare "must stay in lockstep" but nothing enforces it. This
 * script extracts (a) the numeric tuning constants and (b) the route-class →
 * render color mapping from each file and fails (exit 1) if they diverge. The
 * route is colored to MATCH the bike-map legend, so the class→color map must be
 * identical on both platforms (web ROUTE_CLASS_COLORS / iOS RouteClass.color).
 *
 * It's pure text parsing — no build, no Docker, no live server — so it runs in
 * CI and in `npm run check` in well under a second.
 *
 * USAGE:  tsx scripts/check-parity.ts   (or: npm run check)
 * EXIT:   0 in sync · 1 mismatch or a constant/mapping couldn't be located
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const WEB_FILE = path.join(REPO_ROOT, "web", "src", "friendliness.ts");
const IOS_FILE = path.join(
  REPO_ROOT,
  "ios",
  "BikeRouteNicePDX",
  "Services",
  "BikeFriendliness.swift"
);

// Personal street-rating → RouteClass mapping (must also stay in lockstep).
const WEB_RATINGS_FILE = path.join(REPO_ROOT, "web", "src", "streetRatings.ts");
const IOS_RATINGS_FILE = path.join(
  REPO_ROOT,
  "ios",
  "BikeRouteNicePDX",
  "Services",
  "StreetRatings.swift"
);

/** TS constant name → Swift constant name. Both hold the same value. */
const CONSTANT_PAIRS: Array<[web: string, ios: string]> = [
  ["CELL", "cell"],
  ["THRESHOLD_M", "thresholdMeters"],
  ["BEARING_TOL_DEG", "bearingToleranceDeg"],
  ["ARTERIAL_THRESHOLD_M", "arterialThresholdMeters"],
  ["ARTERIAL_BEARING_TOL_DEG", "arterialBearingToleranceDeg"],
  ["MIN_RUN_M", "minRunMeters"],
  ["CALM_MAX_MPH", "calmMaxMph"],
  ["FACILITY_RESCUE_M", "facilityRescueMeters"],
];

const errors: string[] = [];

// ── Load files ──────────────────────────────────────────────────────────────

function read(file: string, label: string): string {
  if (!fs.existsSync(file)) {
    console.error(`✗ ${label} not found at ${file}`);
    process.exit(1);
  }
  return fs.readFileSync(file, "utf8");
}

const webSrc = read(WEB_FILE, "web friendliness.ts");
const iosSrc = read(IOS_FILE, "iOS BikeFriendliness.swift");

// ── Numeric constants ────────────────────────────────────────────────────────

/** Find `(const|let) NAME = <number>` and return the parsed value, or null. */
function constValue(src: string, name: string): number | null {
  // Matches `const CELL = 0.0003;` and `private static let cell = 0.0003`.
  const re = new RegExp(
    `\\b${name}\\b\\s*=\\s*(-?\\d+(?:\\.\\d+)?)`,
  );
  const m = src.match(re);
  return m ? Number(m[1]) : null;
}

for (const [webName, iosName] of CONSTANT_PAIRS) {
  const w = constValue(webSrc, webName);
  const i = constValue(iosSrc, iosName);
  if (w === null) {
    errors.push(`constant ${webName} not found in web/src/friendliness.ts`);
    continue;
  }
  if (i === null) {
    errors.push(`constant ${iosName} not found in BikeFriendliness.swift`);
    continue;
  }
  if (w !== i) {
    errors.push(
      `constant mismatch: web ${webName}=${w}  ≠  iOS ${iosName}=${i}`,
    );
  }
}

// ── Route-class → color mapping ───────────────────────────────────────────────

/** Web: parse the `ROUTE_CLASS_COLORS` object literal → class → #hex (lowered). */
function extractWebColors(): Map<string, string> {
  const block = webSrc.match(/ROUTE_CLASS_COLORS[^{]*\{([\s\S]*?)\}/);
  const map = new Map<string, string>();
  if (!block) {
    errors.push("could not locate ROUTE_CLASS_COLORS in web/src/friendliness.ts");
    return map;
  }
  const re = /(\w+)\s*:\s*"(#[0-9A-Fa-f]{6})"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) {
    map.set(m[1], m[2].toLowerCase());
  }
  return map;
}

/**
 * iOS: parse the `RouteClass` `var color: UIColor` switch → class → #hex, read
 * from the `// #RRGGBB` comment that documents each `case .x:`. (BikeClass.color
 * lives in a different file, so matching `var color` here hits RouteClass only.)
 */
function extractIosColors(): Map<string, string> {
  const fn = iosSrc.match(/var color: UIColor \{[\s\S]*?\n {4}\}/);
  const map = new Map<string, string>();
  if (!fn) {
    errors.push("could not locate RouteClass.color in BikeFriendliness.swift");
    return map;
  }
  const re = /case\s+\.(\w+):[^\n]*?(#[0-9A-Fa-f]{6})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fn[0])) !== null) {
    map.set(m[1], m[2].toLowerCase());
  }
  return map;
}

const webMap = extractWebColors();
const iosMap = extractIosColors();

if (webMap.size && iosMap.size) {
  const classes = new Set([...webMap.keys(), ...iosMap.keys()]);
  for (const k of classes) {
    const w = webMap.get(k);
    const i = iosMap.get(k);
    if (w !== i) {
      errors.push(
        `route-class color mismatch for "${k}": web=${w ?? "(absent)"}  ≠  iOS=${i ?? "(absent)"}`,
      );
    }
  }
}

// ── Comfort-preset → hidden facility-group mapping ────────────────────────────
// The legend's Calm/Balanced/All dial is derived from the shared 5-group Set, so
// each preset's hidden facility-groups MUST match across surfaces. Web table:
// COMFORT_PRESETS in friendliness.ts. iOS: ComfortPreset.hiddenFacilityGroups in
// MKPolyline+Kind.swift (NOT BikeFriendliness.swift), so read that file directly.
const IOS_LANEGROUP_FILE = path.join(
  REPO_ROOT,
  "ios",
  "BikeRouteNicePDX",
  "Extensions",
  "MKPolyline+Kind.swift"
);

/** Normalize a preset → sorted comma-joined group keys, for easy comparison. */
function normPreset(groups: string[]): string {
  return [...groups].sort().join(",");
}

/** Web: parse `COMFORT_PRESETS = { calm: ["caution","shared"], ... }`. */
function extractWebPresets(): Map<string, string> {
  const block = webSrc.match(/COMFORT_PRESETS[^{]*\{([\s\S]*?)\n\}/);
  const map = new Map<string, string>();
  if (!block) {
    errors.push("could not locate COMFORT_PRESETS in web/src/friendliness.ts");
    return map;
  }
  const re = /(\w+)\s*:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) {
    const groups = [...m[2].matchAll(/"(\w+)"/g)].map((g) => g[1]);
    map.set(m[1], normPreset(groups));
  }
  return map;
}

/** iOS: parse the `hiddenGroups` switch — `case .gentle: return [.painted, ...]`. */
function extractIosPresets(): Map<string, string> {
  const src = read(IOS_LANEGROUP_FILE, "iOS MKPolyline+Kind.swift");
  const fn = src.match(/var hiddenGroups: Set<LaneGroup> \{[\s\S]*?\n {4}\}/);
  const map = new Map<string, string>();
  if (!fn) {
    errors.push("could not locate ComfortPreset.hiddenGroups in MKPolyline+Kind.swift");
    return map;
  }
  const re = /case\s+\.(\w+):\s*return\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fn[0])) !== null) {
    const groups = [...m[2].matchAll(/\.(\w+)/g)].map((g) => g[1]);
    map.set(m[1], normPreset(groups));
  }
  return map;
}

const webPresets = extractWebPresets();
const iosPresets = extractIosPresets();

if (webPresets.size && iosPresets.size) {
  const presets = new Set([...webPresets.keys(), ...iosPresets.keys()]);
  for (const k of presets) {
    const w = webPresets.get(k);
    const i = iosPresets.get(k);
    if (w !== i) {
      errors.push(
        `comfort-preset mismatch for "${k}": web=[${w ?? "(absent)"}]  ≠  iOS=[${i ?? "(absent)"}]`,
      );
    }
  }
}

// ── Street-rating → RouteClass mapping ────────────────────────────────────────

/** Web: parse `RATING_TO_CLASS = { great: "protected", ... }` → rating → class. */
function extractWebRatings(): Map<string, string> {
  const src = read(WEB_RATINGS_FILE, "web streetRatings.ts");
  const block = src.match(/RATING_TO_CLASS[^{]*\{([\s\S]*?)\}/);
  const map = new Map<string, string>();
  if (!block) {
    errors.push("could not locate RATING_TO_CLASS in web/src/streetRatings.ts");
    return map;
  }
  const re = /(\w+)\s*:\s*"(\w+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) map.set(m[1], m[2]);
  return map;
}

/** iOS: parse the `routeClass` switch `case .great: return .protected` → map. */
function extractIosRatings(): Map<string, string> {
  const src = read(IOS_RATINGS_FILE, "iOS StreetRatings.swift");
  const fn = src.match(/var routeClass: RouteClass \{[\s\S]*?\n {4}\}/);
  const map = new Map<string, string>();
  if (!fn) {
    errors.push("could not locate StreetRating.routeClass in StreetRatings.swift");
    return map;
  }
  const re = /case\s+\.(\w+):\s*return\s+\.(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(fn[0])) !== null) map.set(m[1], m[2]);
  return map;
}

const webRatings = extractWebRatings();
const iosRatings = extractIosRatings();

if (webRatings.size && iosRatings.size) {
  const ratings = new Set([...webRatings.keys(), ...iosRatings.keys()]);
  for (const k of ratings) {
    const w = webRatings.get(k);
    const i = iosRatings.get(k);
    if (w !== i) {
      errors.push(
        `street-rating class mismatch for "${k}": web=${w ?? "(absent)"}  ≠  iOS=${i ?? "(absent)"}`,
      );
    }
  }
}

// ── Report ───────────────────────────────────────────────────────────────────

if (errors.length) {
  console.error("✗ web ↔ iOS friendliness parity check FAILED:\n");
  for (const e of errors) console.error(`   • ${e}`);
  console.error(
    "\nUpdate web/src/friendliness.ts and ios/.../BikeFriendliness.swift together.",
  );
  process.exit(1);
}

console.log(
  `✓ web ↔ iOS friendliness in sync (${CONSTANT_PAIRS.length} constants, ${webMap.size} route-class colors, ${webPresets.size} comfort presets, ${webRatings.size} street-rating classes)`,
);
