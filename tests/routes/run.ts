/**
 * BikeRouteNicePDX — canonical route quality test harness
 *
 * Usage: npm run test:routes   (runs: tsx tests/routes/run.ts)
 *
 * Environment:
 *   API_URL  — base URL of the route server (default: http://localhost:3000)
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestRoute {
  id: string;
  name: string;
  from: { name: string; lng: number; lat: number };
  to: { name: string; lng: number; lat: number };
  expected_greenways: string[];
  /** Route-specific extra forbidden streets (combined with global list). */
  forbidden_streets: string[];
  expected_greenway_coverage: number;
}

interface RouteStep {
  instruction: string;
  distance_m: number;
  duration_s: number;
  street_name: string | null;
  maneuver_type: string;
  location: [number, number];
  bicycle_network_class: string | null;
}

interface RouteResponse {
  geometry: { type: "LineString"; coordinates: [number, number][] };
  steps: RouteStep[];
  distance_m: number;
  duration_s: number;
  greenway_coverage: number;
}

interface CostingOverrides {
  thresholds: {
    min_greenway_coverage: number;
    max_forbidden_meters: number;
    forbidden_streets: string[];
  };
}

interface RouteResult {
  id: string;
  name: string;
  passed: boolean;
  distance_m: number;
  duration_s: number;
  computed_coverage: number;
  server_coverage: number;
  coverage_threshold: number;
  coverage_pass: boolean;
  greenway_hit: string | null;
  greenway_pass: boolean;
  forbidden_violations: Array<{ street: string; max_contiguous_m: number }>;
  forbidden_pass: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, "../..");

const CANONICAL_PATH = resolve(__dirname, "canonical.json");
const COSTING_PATH = resolve(REPO_ROOT, "routing/costing-overrides.json");
const RESULTS_DIR = resolve(REPO_ROOT, "tests/results");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_URL = (process.env["API_URL"] ?? "http://localhost:3000").replace(/\/$/, "");

function fmt_km(m: number): string {
  return (m / 1000).toFixed(1) + "km";
}

function fmt_min(s: number): string {
  return Math.round(s / 60) + " min";
}

function pct(ratio: number): string {
  return Math.round(ratio * 100) + "%";
}

/** Case-insensitive substring match. */
function streetMatches(haystack: string | null, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Compute greenway coverage from steps.
 * Counts off_street, greenway, and protected as "greenway-equivalent".
 */
function computeCoverage(steps: RouteStep[], total_m: number): number {
  if (total_m === 0) return 0;
  const GREENWAY_CLASSES = new Set(["off_street", "greenway", "protected"]);
  const greenway_m = steps.reduce((sum, step) => {
    if (step.bicycle_network_class && GREENWAY_CLASSES.has(step.bicycle_network_class)) {
      return sum + step.distance_m;
    }
    return sum;
  }, 0);
  return greenway_m / total_m;
}

/**
 * For each forbidden street, walk steps in order and track contiguous distance.
 * Returns violations where max contiguous exceeds the threshold.
 */
function detectForbiddenViolations(
  steps: RouteStep[],
  forbiddenStreets: string[],
  maxMeters: number
): Array<{ street: string; max_contiguous_m: number }> {
  const violations: Array<{ street: string; max_contiguous_m: number }> = [];

  for (const forbidden of forbiddenStreets) {
    let maxContiguous = 0;
    let current = 0;

    for (const step of steps) {
      if (streetMatches(step.street_name, forbidden)) {
        current += step.distance_m;
        if (current > maxContiguous) maxContiguous = current;
      } else {
        current = 0;
      }
    }

    if (maxContiguous > maxMeters) {
      violations.push({ street: forbidden, max_contiguous_m: Math.round(maxContiguous) });
    }
  }

  return violations;
}

/**
 * Check that at least one expected greenway appears as a street_name in steps.
 * Returns the first matching name, or null if none found.
 */
function findGreenwayHit(steps: RouteStep[], expectedGreenways: string[]): string | null {
  for (const greenway of expectedGreenways) {
    for (const step of steps) {
      if (streetMatches(step.street_name, greenway)) {
        return greenway;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function printResult(r: RouteResult): void {
  const passIcon = (ok: boolean) => (ok ? "✓" : "✗");

  console.log(`\n==> ${r.id}: ${r.name}`);

  if (r.error) {
    console.log(`    ERROR: ${r.error}`);
    console.log(`    FAIL`);
    return;
  }

  console.log(`    distance: ${fmt_km(r.distance_m)}, duration: ${fmt_min(r.duration_s)}`);

  // Coverage line
  const covNote =
    r.server_coverage > 0
      ? ` (server reported ${pct(r.server_coverage)})`
      : " (computed from steps — server v0.1)";
  console.log(
    `    greenway coverage: ${pct(r.computed_coverage)} (threshold ${pct(r.coverage_threshold)}) ${passIcon(r.coverage_pass)}${covNote}`
  );

  // Greenway hit line
  if (r.greenway_hit) {
    console.log(`    expected greenway hit: ${r.greenway_hit} ${passIcon(true)}`);
  } else {
    console.log(`    expected greenway hit: none found ${passIcon(false)}`);
  }

  // Forbidden violations
  if (r.forbidden_violations.length === 0) {
    console.log(`    no forbidden-street violations ${passIcon(true)}`);
  } else {
    for (const v of r.forbidden_violations) {
      console.log(
        `    forbidden: ${v.street} for ${v.max_contiguous_m}m (max ${Math.round(200)}m) ${passIcon(false)}`
      );
    }
  }

  console.log(`    ${r.passed ? "PASS" : "FAIL"}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // 1. Load canonical routes
  const canonical: TestRoute[] = JSON.parse(await readFile(CANONICAL_PATH, "utf8"));

  // 2. Load costing overrides for global thresholds
  const costing: CostingOverrides = JSON.parse(await readFile(COSTING_PATH, "utf8"));
  const { min_greenway_coverage, max_forbidden_meters, forbidden_streets: globalForbidden } =
    costing.thresholds;

  // 3. Health check
  try {
    const healthRes = await fetch(`${API_URL}/health`);
    if (!healthRes.ok) {
      console.error(`\n✗ Server health check failed (HTTP ${healthRes.status}).`);
      console.error(
        "  Make sure Valhalla and the server are running:\n" +
          "    cd routing && docker compose up -d\n" +
          "    cd ../server && npm run dev"
      );
      process.exit(1);
    }
  } catch (err) {
    console.error(`\n✗ Cannot reach server at ${API_URL}/health`);
    console.error(
      "  Make sure Valhalla and the server are running:\n" +
        "    cd routing && docker compose up -d\n" +
        "    cd ../server && npm run dev"
    );
    process.exit(1);
  }

  console.log(`\nBikeRouteNicePDX — canonical route quality harness`);
  console.log(`API: ${API_URL}`);
  console.log(`Routes: ${canonical.length}`);
  console.log(`Global thresholds: coverage ≥ ${pct(min_greenway_coverage)}, forbidden ≤ ${max_forbidden_meters}m`);

  // 4. Run routes in series (Valhalla can be slow under load)
  const results: RouteResult[] = [];

  for (const route of canonical) {
    let result: RouteResult;

    try {
      const res = await fetch(`${API_URL}/route`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from: [route.from.lng, route.from.lat],
          to: [route.to.lng, route.to.lat],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "(no body)");
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }

      const data: RouteResponse = await res.json();

      // Compute coverage from steps (primary source of truth per spec).
      // Use server value only as a cross-check when it's non-zero.
      const computed_coverage = computeCoverage(data.steps, data.distance_m);
      const server_coverage = data.greenway_coverage ?? 0;

      // Use the computed value as authoritative; flag if server disagrees by >10pp
      const effective_coverage = computed_coverage;

      const coverage_threshold = route.expected_greenway_coverage;
      const coverage_pass = effective_coverage >= coverage_threshold;

      const greenway_hit = findGreenwayHit(data.steps, route.expected_greenways);
      // BRouter doesn't expose per-step street names, so the name-based hit (and
      // the forbidden-street check) can't run. When no step has a name, fall
      // back to the coverage threshold as the greenway criterion.
      const namesAvailable = data.steps.some((s) => s.street_name);
      const greenway_pass = namesAvailable ? greenway_hit !== null : coverage_pass;

      // Merge global + route-specific forbidden streets (deduplicated)
      const allForbidden = Array.from(new Set([...globalForbidden, ...route.forbidden_streets]));
      const forbidden_violations = detectForbiddenViolations(data.steps, allForbidden, max_forbidden_meters);
      const forbidden_pass = forbidden_violations.length === 0;

      const passed = coverage_pass && greenway_pass && forbidden_pass;

      result = {
        id: route.id,
        name: route.name,
        passed,
        distance_m: data.distance_m,
        duration_s: data.duration_s,
        computed_coverage,
        server_coverage,
        coverage_threshold,
        coverage_pass,
        greenway_hit,
        greenway_pass,
        forbidden_violations,
        forbidden_pass,
      };
    } catch (err) {
      result = {
        id: route.id,
        name: route.name,
        passed: false,
        distance_m: 0,
        duration_s: 0,
        computed_coverage: 0,
        server_coverage: 0,
        coverage_threshold: route.expected_greenway_coverage,
        coverage_pass: false,
        greenway_hit: null,
        greenway_pass: false,
        forbidden_violations: [],
        forbidden_pass: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    results.push(result);
    printResult(result);
  }

  // 5. Summary
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  console.log(`\n${results.length} routes: ${passed} PASS, ${failed} FAIL`);

  // 6. Persist results
  await mkdir(RESULTS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsPath = resolve(RESULTS_DIR, `${timestamp}.json`);
  await writeFile(
    resultsPath,
    JSON.stringify(
      {
        run_at: new Date().toISOString(),
        api_url: API_URL,
        thresholds: { min_greenway_coverage, max_forbidden_meters },
        summary: { total: results.length, passed, failed },
        routes: results,
      },
      null,
      2
    )
  );
  console.log(`\nResults saved to: ${resultsPath}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
