/**
 * BRouter routing client — the greenway-preferring engine.
 *
 * Replaces Valhalla for POST /route. BRouter reads OSM lcn route relations and
 * penalizes non-bike roads, so it follows Portland's neighborhood greenways far
 * better than Valhalla (~2x greenway coverage on the canonical routes).
 *
 * BRouter has no turn-by-turn maneuvers or map-matching, so:
 *  - steps are synthesized from the geometry: real turns detected by bearing
 *    analysis (turn-detect.ts) with street names recovered from the PBOT
 *    bike-network index, so guidance stays useful even when Valhalla is down.
 *    Valhalla trace_route remains the preferred enricher when reachable.
 *  - the coverage metric is computed from the same per-segment PBOT
 *    classification as before (independent of step boundaries).
 *  - the finger-draw /match flow stays on Valhalla (see matchTrace).
 */

import { config } from "../config.js";
import { ValhallaError, traceRouteSteps } from "./valhalla.js";
import type { RouteResult, RouteStep } from "./valhalla.js";
import {
  classifyPoint,
  isGreenwayEquivalent,
  nearestWayName,
  CALM_CLASSES,
  type NetworkClass,
} from "./greenway-coverage.js";
import { detectTurns, cumulativeArcs, pointAtArc, bearingDeg } from "./turn-detect.js";
import {
  composeInstruction,
  spokenClause,
  displayStreetName,
  expandStreetName,
} from "../voice/instructions.js";

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
  // turn-by-turn from Valhalla trace_route; fall back to geometry-detected
  // turns with bike-network street names.
  const fallback = synthesizeSteps(coords, duration_s);
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

const COMPASS_WORDS = [
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
];

function compassWord(deg: number): string {
  return COMPASS_WORDS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

/**
 * Synthesize directions steps from the geometry. Turns come from bearing
 * analysis (detectTurns), street names from the PBOT bike-network index
 * (nearestWayName, sampled just past each maneuver with bearing agreement so
 * cross streets don't win). Coverage (greenway/calm meters) is computed from
 * the same per-segment PBOT classification as always — step boundaries do not
 * affect it.
 */
function synthesizeSteps(
  coords: [number, number][],
  durationS: number
): {
  steps: RouteStep[];
  greenwayMeters: number;
  calmMeters: number;
} {
  const steps: RouteStep[] = [];
  let greenwayMeters = 0;
  let calmMeters = 0;
  if (coords.length < 2) return { steps, greenwayMeters, calmMeters };

  // Per-segment PBOT classification — identical math to the coverage metric's
  // original loop; classes are kept so each step can report its dominant class.
  const segLens = new Array<number>(coords.length - 1).fill(0);
  const segCls = new Array<NetworkClass | null>(coords.length - 1).fill(null);
  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    const segLen = distMeters(a, b);
    if (segLen === 0) continue;
    segLens[i] = segLen;
    const mid: [number, number] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const cls =
      classifyPoint(mid[0], mid[1]) ??
      classifyPoint(a[0], a[1]) ??
      classifyPoint(b[0], b[1]);
    segCls[i] = cls;
    if (isGreenwayEquivalent(cls)) greenwayMeters += segLen;
    if (cls !== null && CALM_CLASSES.has(cls)) calmMeters += segLen;
  }

  const arcs = cumulativeArcs(coords);
  const total = arcs[arcs.length - 1];

  /** Length-weighted dominant class over segments [i0, i1). */
  const stretchClass = (i0: number, i1: number): NetworkClass | null => {
    const tally = new Map<NetworkClass | null, number>();
    for (let i = i0; i < i1 && i < segCls.length; i++) {
      if (segLens[i] === 0) continue;
      tally.set(segCls[i], (tally.get(segCls[i]) ?? 0) + segLens[i]);
    }
    let bestCls: NetworkClass | null = null;
    let bestLen = -1;
    for (const [cls, len] of tally) {
      if (len > bestLen) {
        bestLen = len;
        bestCls = cls;
      }
    }
    return bestCls;
  };

  /** Street name ~20 m past an arc position, matched to the outgoing bearing. */
  const nameAt = (arc: number): string | null => {
    const sample = pointAtArc(coords, arcs, Math.min(total, arc + 20));
    const b0 = pointAtArc(coords, arcs, Math.min(total, arc + 10));
    const b1 = pointAtArc(coords, arcs, Math.min(total, arc + 30));
    const brg = b0[0] !== b1[0] || b0[1] !== b1[1] ? bearingDeg(b0, b1) : null;
    return nearestWayName(sample[0], sample[1], brg);
  };

  interface Boundary {
    index: number;
    arc: number;
    maneuver: string;
  }
  // Boundaries at detected turns AND at PBOT class changes. Class boundaries
  // (plain "continue" steps) keep each step class-pure, so coverage computed
  // from steps matches the geometry metric exactly (tests/routes/run.ts treats
  // steps as the source of truth) and greenway/busy-street entry announcements
  // fire at the true infra transition, as the old class-run steps did.
  const turnIndices = new Set<number>();
  const boundaries: Boundary[] = [{ index: 0, arc: 0, maneuver: "start" }];
  for (const t of detectTurns(coords)) {
    turnIndices.add(t.index);
    boundaries.push({ index: t.index, arc: t.arc, maneuver: t.maneuver_type });
  }
  let prevCls: NetworkClass | null = null;
  let seenFirst = false;
  for (let i = 0; i < segCls.length; i++) {
    if (segLens[i] === 0) continue;
    if (seenFirst && segCls[i] !== prevCls && i > 0 && !turnIndices.has(i)) {
      boundaries.push({ index: i, arc: arcs[i], maneuver: "continue" });
    }
    prevCls = segCls[i];
    seenFirst = true;
  }
  boundaries.sort((a, b) => a.index - b.index);

  for (let k = 0; k < boundaries.length; k++) {
    const cur = boundaries[k];
    const next = boundaries[k + 1];
    const endArc = next ? next.arc : total;
    const endIndex = next ? next.index : coords.length - 1;
    const cls = stretchClass(cur.index, endIndex);
    const name = nameAt(cur.arc);

    let instruction: string;
    let spoken: string;
    if (cur.maneuver === "start") {
      const dir = compassWord(bearingDeg(coords[0], pointAtArc(coords, arcs, Math.min(total, 25))));
      instruction = name ? `Head ${dir} on ${displayStreetName(name)}` : `Head ${dir}`;
      spoken = name ? `head ${dir} on ${expandStreetName(name)}` : `head ${dir}`;
    } else {
      instruction = composeInstruction(cur.maneuver, name, cls);
      spoken = spokenClause(cur.maneuver, name, cls);
    }

    steps.push({
      instruction,
      distance_m: Math.round(endArc - cur.arc),
      duration_s: total > 0 ? Math.round((durationS * (endArc - cur.arc)) / total) : 0,
      street_name: name ? displayStreetName(name) : null,
      maneuver_type: cur.maneuver,
      location: coords[cur.index],
      bicycle_network_class: cls,
      spoken,
    });
  }

  const last = boundaries[boundaries.length - 1];
  steps.push({
    instruction: "Arrive at your destination",
    distance_m: 0,
    duration_s: 0,
    street_name: null,
    maneuver_type: "destination",
    location: coords[coords.length - 1],
    bicycle_network_class: stretchClass(last.index, coords.length - 1),
    spoken: "arrive at your destination",
  });

  return { steps, greenwayMeters, calmMeters };
}
