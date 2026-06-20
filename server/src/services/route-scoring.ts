/**
 * route-scoring.ts
 *
 * Scores candidate routes from different engines so the bake-off can pick the
 * best one to recommend. Uses the project's existing signals:
 *
 *  - greenway_coverage (already on each RouteResult, computed identically across
 *    engines via route-synth / greenway-coverage).
 *  - forbidden-arterial usage: worst contiguous distance on a no-go street
 *    (same street-name walk the canonical harness uses).
 *  - distance sanity: penalize routes much longer than the shortest candidate,
 *    so a tiny coverage win can't justify a big detour.
 *
 * The preference slider (comfort↔fast) shifts the weights: comfort maximizes
 * coverage, fast leans on directness, balanced sits between.
 *
 * FORBIDDEN_STREETS / MAX_FORBIDDEN_M mirror routing/costing-overrides.json
 * (thresholds). They're duplicated here — like graph.lua's factor table — so the
 * live request path has no file-system dependency. Keep them in sync.
 */

import type { RouteResult, RouteStep } from "./valhalla.js";
import type { EngineName } from "./engine-skip.js";

const FORBIDDEN_STREETS: readonly string[] = [
  "Sandy Blvd",
  "SE Powell Blvd",
  "SE Cesar Chavez Blvd",
  "NE Martin Luther King Jr Blvd",
  "W Burnside St",
  "E Burnside St",
  "82nd Ave",
];
const MAX_FORBIDDEN_M = 200;

interface Weights {
  cov: number; // reward for greenway coverage
  dist: number; // penalty per unit of relative detour vs the shortest candidate
  forbid: number; // penalty per MAX_FORBIDDEN_M of forbidden-street use
}

const WEIGHTS_BY_PREFERENCE: Record<string, Weights> = {
  comfort: { cov: 1.0, dist: 0.5, forbid: 1.2 },
  balanced: { cov: 0.6, dist: 1.0, forbid: 0.9 },
  fast: { cov: 0.25, dist: 1.6, forbid: 0.5 },
};

export interface ScoredRoute {
  engine: EngineName;
  result: RouteResult;
  score: number;
  coverage: number;
  distance_m: number;
  duration_s: number;
  forbidden_m: number; // worst contiguous distance on a forbidden street
}

/** Case-insensitive substring match (mirrors the canonical harness). */
function streetMatches(haystack: string | null, needle: string): boolean {
  if (!haystack) return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Worst contiguous distance (m) the route spends on any forbidden street,
 * walking steps in order. Mirrors detectForbiddenViolations in the harness.
 */
export function maxContiguousForbidden(steps: RouteStep[]): number {
  let worst = 0;
  for (const forbidden of FORBIDDEN_STREETS) {
    let current = 0;
    for (const step of steps) {
      if (streetMatches(step.street_name, forbidden)) {
        current += step.distance_m;
        if (current > worst) worst = current;
      } else {
        current = 0;
      }
    }
  }
  return Math.round(worst);
}

/**
 * Score + rank candidates (best first). Score is relative: the distance penalty
 * is measured against the shortest candidate in the set, so it only makes sense
 * within a single bake-off.
 */
export function scoreRoutes(
  candidates: Array<{ engine: EngineName; result: RouteResult }>,
  preference: string = "comfort"
): ScoredRoute[] {
  const w = WEIGHTS_BY_PREFERENCE[preference] ?? WEIGHTS_BY_PREFERENCE.comfort;

  const shortest = Math.min(
    ...candidates.map((c) => c.result.distance_m).filter((d) => d > 0)
  );
  const base = Number.isFinite(shortest) && shortest > 0 ? shortest : 1;

  const scored: ScoredRoute[] = candidates.map(({ engine, result }) => {
    const coverage = result.greenway_coverage ?? 0;
    const forbidden_m = maxContiguousForbidden(result.steps);

    const detour = Math.max(0, result.distance_m / base - 1); // 0 for the shortest
    const forbidPenalty = forbidden_m / MAX_FORBIDDEN_M;

    const score = coverage * w.cov - detour * w.dist - forbidPenalty * w.forbid;

    return {
      engine,
      result,
      score,
      coverage,
      distance_m: result.distance_m,
      duration_s: result.duration_s,
      forbidden_m,
    };
  });

  // Best score first; tie-break on higher coverage, then shorter distance.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.coverage - a.coverage ||
      a.distance_m - b.distance_m
  );
  return scored;
}
