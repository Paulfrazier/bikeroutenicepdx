/**
 * check-parity.ts — guard the web ↔ iOS bike-friendliness classifier parity.
 *
 * The friendliness algorithm is duplicated in two hand-maintained files:
 *   web/src/friendliness.ts                       (TypeScript)
 *   ios/BikeRouteNicePDX/Services/BikeFriendliness.swift  (Swift)
 * Both files declare "must stay in lockstep" but nothing enforces it. This
 * script extracts (a) the numeric tuning constants and (b) the facility
 * class → tier mapping from each file and fails (exit 1) if they diverge.
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

/** TS constant name → Swift constant name. Both hold the same value. */
const CONSTANT_PAIRS: Array<[web: string, ios: string]> = [
  ["CELL", "cell"],
  ["THRESHOLD_M", "thresholdMeters"],
  ["BEARING_TOL_DEG", "bearingToleranceDeg"],
  ["ARTERIAL_THRESHOLD_M", "arterialThresholdMeters"],
  ["ARTERIAL_BEARING_TOL_DEG", "arterialBearingToleranceDeg"],
  ["MIN_RUN_M", "minRunMeters"],
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

// ── Class → tier mapping ─────────────────────────────────────────────────────

const DEFAULT_KEY = "*default*";

/**
 * Parse a `switch` body that maps class strings to a tier. Accumulates the
 * `case "x":` labels (and bare `default:`) that precede each `return <tier>`,
 * mapping every accumulated label to that tier. Returns class → tier.
 * `tierOf` normalizes the matched return token (e.g. `"green"` or `.green`).
 */
function parseMapping(
  body: string,
  caseRe: RegExp,
  returnRe: RegExp,
): Map<string, string> {
  const map = new Map<string, string>();
  let pending: string[] = [];
  // Walk the body token-by-token in source order.
  const tokenRe = new RegExp(
    `${caseRe.source}|${returnRe.source}|\\bdefault\\b`,
    "g",
  );
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    const text = m[0];
    if (/\bdefault\b/.test(text) && !/return/.test(text)) {
      pending.push(DEFAULT_KEY);
      continue;
    }
    const caseMatch = text.match(caseRe);
    const retMatch = text.match(returnRe);
    if (retMatch) {
      const tier = retMatch[1];
      for (const label of pending) map.set(label, tier);
      pending = [];
    } else if (caseMatch) {
      // One `case` token may list several quoted labels.
      const labels = caseMatch[0].match(/"([^"]+)"/g) ?? [];
      for (const l of labels) pending.push(l.replace(/"/g, ""));
    }
  }
  return map;
}

// Web: `function classToTier(...) { switch (cls) { ... } }`
function extractWebMapping(): Map<string, string> {
  const fn = webSrc.match(/function classToTier[\s\S]*?\n}/);
  if (!fn) {
    errors.push("could not locate classToTier() in web/src/friendliness.ts");
    return new Map();
  }
  return parseMapping(
    fn[0],
    /case\s+(?:"[^"]+"\s*,?\s*)+:/, // `case "a":` possibly stacked
    /return\s+"(\w+)"/,
  );
}

// iOS: `static func tier(forClass cls: String) -> FriendlyTier { switch ... }`
function extractIosMapping(): Map<string, string> {
  const fn = iosSrc.match(/static func tier\(forClass[\s\S]*?\n {4}}/);
  if (!fn) {
    errors.push("could not locate tier(forClass:) in BikeFriendliness.swift");
    return new Map();
  }
  return parseMapping(
    fn[0],
    /case\s+(?:"[^"]+"\s*,?\s*)+:/,
    /return\s+\.(\w+)/,
  );
}

const webMap = extractWebMapping();
const iosMap = extractIosMapping();

if (webMap.size && iosMap.size) {
  // Compare EFFECTIVE tiers: a class absent from one switch falls to that
  // switch's `default`. So web's explicit `case "shared" → red` and iOS's
  // `default → red` (no explicit "shared" case) are equivalent, not a mismatch.
  const webDefault = webMap.get(DEFAULT_KEY);
  const iosDefault = iosMap.get(DEFAULT_KEY);
  if (webDefault !== iosDefault) {
    errors.push(
      `class→tier mismatch for default: web=${webDefault ?? "(absent)"}  ≠  iOS=${iosDefault ?? "(absent)"}`,
    );
  }
  const classes = new Set(
    [...webMap.keys(), ...iosMap.keys()].filter((k) => k !== DEFAULT_KEY),
  );
  for (const k of classes) {
    const w = webMap.get(k) ?? webDefault;
    const i = iosMap.get(k) ?? iosDefault;
    if (w !== i) {
      errors.push(
        `class→tier mismatch for "${k}": web=${w ?? "(absent)"}  ≠  iOS=${i ?? "(absent)"}`,
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
  `✓ web ↔ iOS friendliness in sync (${CONSTANT_PAIRS.length} constants, ${webMap.size} class mappings)`,
);
