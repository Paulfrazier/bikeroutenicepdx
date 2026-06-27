/**
 * BRouter routing client — the greenway-preferring engine.
 *
 * Replaces Valhalla for POST /route. BRouter reads OSM lcn route relations and
 * penalizes non-bike roads, so it follows Portland's neighborhood greenways far
 * better than Valhalla (~2x greenway coverage on the canonical routes).
 *
 * BRouter has no turn-by-turn maneuvers or map-matching, so:
 *  - steps are synthesized from the geometry, grouped by PBOT class (this drives
 *    the web directions pills + the coverage metric). Street names/turn text are
 *    not available from BRouter and are left null/generic.
 *  - the finger-draw /match flow stays on Valhalla (see matchTrace).
 */

import { config } from "../config.js";
import { ValhallaError, traceRouteSteps } from "./valhalla.js";
import type { RouteResult, RouteStep } from "./valhalla.js";
import {
  classifyPoint,
  isGreenwayEquivalent,
  CALM_CLASSES,
  type NetworkClass,
} from "./greenway-coverage.js";

/**
 * preference → BRouter profile. Both bike tiers are our custom profiles in
 * brouter-service/profiles/: `safety-ultra` prefers greenways/bike-infra hardest
 * for "ultra", and `safety-comfort` is stock `safety` (the greenway A/B winner)
 * plus a maxspeed penalty so "comfort" also leans off fast bike-laned streets.
 * `balanced`/`fast` use the unmodified stock BRouter profiles.
 */
const PROFILE_BY_PREFERENCE: Record<string, string> = {
  ultra: "safety-ultra",
  comfort: "safety-comfort",
  balanced: "trekking",
  fast: "fastbike",
};

// Equirectangular metres between two [lng,lat] points (city-scale accurate).
function distMeters(a: [number, number], b: [number, number]): number {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((a[0] - b[0]) * mLng, (a[1] - b[1]) * mLat);
}

interface BrouterGeoJSON {
  features?: Array<{
    properties?: Record<string, string>;
    geometry?: { type: string; coordinates: number[][] };
  }>;
}

/** Raw geometry from one BRouter call — no step naming, no map-match. */
export interface BrouterGeometry {
  coords: [number, number][];
  distance_m: number;
  duration_s: number;
}

/**
 * Fetch a single BRouter route as bare geometry (+ length/time), skipping the
 * expensive Valhalla step-naming. This is the cheap building block for fetching
 * several candidates per request (alternatives, facility-via probes); the one
 * map-match is paid only once, on the chosen winner, by getRouteBrouter.
 *
 * `profile` is a resolved BRouter profile name (not a preference). `alternativeidx`
 * selects BRouter's ranked alternatives (0 = primary, 1..3 = variants).
 */
/**
 * Routing engine selector. "prod" = stock brouter.de tiles (config.brouterUrl);
 * "selfbuild" = the self-built PBOT-patched tiles (config.brouterUrlSelfbuild).
 * Used for the in-app prod-vs-selfbuild A/B. Unknown/absent → "prod".
 */
export type RouteEngine = "prod" | "selfbuild";

export function resolveBrouterUrl(engine: string = "prod"): string {
  return engine === "selfbuild" ? config.brouterUrlSelfbuild : config.brouterUrl;
}

export async function fetchBrouterGeometry(
  from: [number, number], // [lng, lat]
  to: [number, number], // [lng, lat]
  vias: [number, number][] = [],
  profile: string = "safety",
  alternativeidx: number = 0,
  brouterBaseUrl: string = config.brouterUrl
): Promise<BrouterGeometry> {
  const lonlats = [from, ...vias, to]
    .map(([lng, lat]) => `${lng},${lat}`)
    .join("|");
  const url =
    `${brouterBaseUrl}/brouter?lonlats=${encodeURIComponent(lonlats)}` +
    `&profile=${profile}&alternativeidx=${alternativeidx}&format=geojson`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValhallaError(`BRouter unreachable: ${message}`, "unreachable", 502);
  }

  // BRouter returns 200 with a plain-text error body when it can't route.
  const text = await res.text();
  if (!res.ok) {
    throw new ValhallaError(
      text.slice(0, 200) || `BRouter HTTP ${res.status}`,
      "upstream_error",
      502
    );
  }

  let data: BrouterGeoJSON;
  try {
    data = JSON.parse(text) as BrouterGeoJSON;
  } catch {
    // Non-JSON body = BRouter routing error (e.g. "operation killed by ...").
    throw new ValhallaError(
      text.trim().slice(0, 200) || "No route found",
      "no_route",
      422
    );
  }

  const feat = data.features?.[0];
  if (!feat?.geometry?.coordinates?.length) {
    throw new ValhallaError("BRouter returned no route geometry", "no_route", 422);
  }

  // BRouter coords are [lng, lat, elevation] — drop elevation.
  const coords: [number, number][] = feat.geometry.coordinates.map((c) => [
    c[0],
    c[1],
  ]);
  const distance_m = Math.round(Number(feat.properties?.["track-length"] ?? 0));
  const duration_s = Math.round(Number(feat.properties?.["total-time"] ?? 0));
  return { coords, distance_m, duration_s };
}

export async function getRouteBrouter(
  from: [number, number], // [lng, lat]
  to: [number, number], // [lng, lat]
  vias: [number, number][] = [],
  preference: string = "comfort",
  engine: string = "prod"
): Promise<RouteResult> {
  const profile = PROFILE_BY_PREFERENCE[preference] ?? "safety";
  const { coords, distance_m, duration_s } = await fetchBrouterGeometry(
    from,
    to,
    vias,
    profile,
    0,
    resolveBrouterUrl(engine)
  );

  // Coverage is always computed from BRouter's geometry. Steps prefer named
  // turn-by-turn from Valhalla trace_route; fall back to class-only runs.
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
    calm_coverage:
      totalForCoverage > 0 ? fallback.calmMeters / totalForCoverage : 0,
  };
}

function sumLength(coords: [number, number][]): number {
  let t = 0;
  for (let i = 0; i < coords.length - 1; i++) t += distMeters(coords[i], coords[i + 1]);
  return t;
}

/**
 * Synthesize directions steps from the geometry: classify each segment by PBOT
 * class and merge consecutive same-class runs into a step. Also returns the
 * total greenway-equivalent distance for coverage.
 */
function buildSteps(coords: [number, number][]): {
  steps: RouteStep[];
  greenwayMeters: number;
  calmMeters: number;
} {
  const steps: RouteStep[] = [];
  let greenwayMeters = 0;
  let calmMeters = 0;
  if (coords.length < 2) return { steps, greenwayMeters, calmMeters };

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
      street_name: null, // BRouter geojson doesn't expose per-step names
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
    if (cls !== null && CALM_CLASSES.has(cls)) calmMeters += segLen;

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
  return { steps, greenwayMeters, calmMeters };
}
