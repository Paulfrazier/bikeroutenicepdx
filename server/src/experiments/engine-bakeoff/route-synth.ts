/**
 * route-synth.ts
 *
 * Shared "bare geometry → RouteResult" assembler for the engines that return
 * only a polyline (BRouter, ORS, GraphHopper) — none expose turn-by-turn
 * maneuvers or our PBOT bicycle_network_class, so we synthesize both here:
 *
 *  - steps: classify each segment by PBOT class and merge consecutive same-class
 *    runs (drives the web directions pills + the geometry-based coverage metric).
 *    Street names are then recovered, best-effort, by map-matching the geometry
 *    onto Valhalla /trace_route (traceRouteSteps).
 *  - greenway_coverage: share of distance on greenway-equivalent infra, computed
 *    straight from the geometry (independent of whether naming succeeded) so the
 *    metric is identical across every engine in the bake-off.
 *
 * Extracted from brouter.ts so ORS/GraphHopper reuse the exact same logic and
 * the coverage number stays comparable engine-to-engine.
 */

import { traceRouteSteps } from "../../services/valhalla.js";
import type { RouteResult, RouteStep } from "../../services/valhalla.js";
import {
  classifyPoint,
  isGreenwayEquivalent,
  type NetworkClass,
} from "../../services/greenway-coverage.js";

// Equirectangular metres between two [lng,lat] points (city-scale accurate).
export function distMeters(a: [number, number], b: [number, number]): number {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((a[0] - b[0]) * mLng, (a[1] - b[1]) * mLat);
}

export function sumLength(coords: [number, number][]): number {
  let t = 0;
  for (let i = 0; i < coords.length - 1; i++) t += distMeters(coords[i], coords[i + 1]);
  return t;
}

/**
 * Synthesize directions steps from the geometry: classify each segment by PBOT
 * class and merge consecutive same-class runs into a step. Also returns the
 * total greenway-equivalent distance for coverage.
 */
export function buildSteps(coords: [number, number][]): {
  steps: RouteStep[];
  greenwayMeters: number;
} {
  const steps: RouteStep[] = [];
  let greenwayMeters = 0;
  if (coords.length < 2) return { steps, greenwayMeters };

  let runClass: NetworkClass | null = null;
  let runMeters = 0;
  let runStart = coords[0];
  let started = false;

  const flush = (atEnd: boolean) => {
    if (!started) return;
    steps.push({
      instruction: steps.length === 0 ? "Start" : atEnd ? "Arrive" : "Continue",
      distance_m: Math.round(runMeters),
      duration_s: 0,
      street_name: null, // bare-geometry engines don't expose per-step names
      maneuver_type: steps.length === 0 ? "start" : atEnd ? "destination" : "continue",
      location: runStart,
      bicycle_network_class: runClass,
    });
  };

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = distMeters(a, b);
    if (segLen === 0) continue;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const cls =
      classifyPoint(mid[0], mid[1]) ??
      classifyPoint(a[0], a[1]) ??
      classifyPoint(b[0], b[1]);
    if (isGreenwayEquivalent(cls)) greenwayMeters += segLen;

    if (!started) {
      started = true;
      runClass = cls;
      runMeters = segLen;
      runStart = a;
    } else if (cls === runClass) {
      runMeters += segLen;
    } else {
      flush(false);
      runClass = cls;
      runMeters = segLen;
      runStart = a;
    }
  }
  flush(true);
  return { steps, greenwayMeters };
}

/**
 * Assemble a full RouteResult from a bare [lng,lat] polyline + totals.
 * Coverage is geometry-derived; steps prefer named turn-by-turn from Valhalla
 * trace_route, falling back to class-only runs when matching is unavailable.
 */
export async function assembleRouteFromGeometry(
  coords: [number, number][],
  distance_m: number,
  duration_s: number
): Promise<RouteResult> {
  const fallback = buildSteps(coords);
  let steps: RouteStep[] = fallback.steps;
  try {
    const named = await traceRouteSteps(coords);
    if (named.length) steps = named;
  } catch {
    // Valhalla unavailable / no match — keep the class-only steps.
  }
  const totalForCoverage = distance_m > 0 ? distance_m : sumLength(coords);

  return {
    geometry: { type: "LineString", coordinates: coords },
    steps,
    distance_m,
    duration_s,
    greenway_coverage:
      totalForCoverage > 0 ? fallback.greenwayMeters / totalForCoverage : 0,
  };
}
