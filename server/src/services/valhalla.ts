/**
 * Valhalla routing client.
 *
 * Wraps POST /route, decodes polyline6, assembles GeoJSON + steps.
 *
 * Greenway coverage (v0.1): hardcoded to 0. Computing it properly requires
 * per-edge attributes from Valhalla (available via verbose=true / shape_attributes
 * in newer Valhalla builds, or via the custom bicycle_network_class attribute
 * injected by scripts/build-graph.ts). Wire up in Phase 2 once Valhalla edge
 * attributes are confirmed working.
 * TODO(v1): switch verbose=true, extract edge[].road_class / bicycle_network,
 *   accumulate weighted sum to compute real greenway_coverage.
 */

import { config } from "../config.js";
import { dominantClass, isGreenwayEquivalent } from "./greenway-coverage.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeoJSONLineString {
  type: "LineString";
  coordinates: [number, number][]; // [lng, lat]
}

export interface RouteStep {
  instruction: string;
  distance_m: number;
  duration_s: number;
  street_name: string | null;
  maneuver_type: string;
  location: [number, number]; // [lng, lat]
  bicycle_network_class: string | null;
}

export interface RouteResult {
  geometry: GeoJSONLineString;
  steps: RouteStep[];
  distance_m: number;
  duration_s: number;
  greenway_coverage: number;
}

// ---------------------------------------------------------------------------
// Valhalla API response shapes (partial — only what we consume)
// ---------------------------------------------------------------------------

interface ValhallaManeuver {
  type: number;
  instruction: string;
  street_names?: string[];
  length: number;    // km
  time: number;      // seconds
  begin_shape_index: number;
  end_shape_index: number;
}

interface ValhallaLeg {
  maneuvers: ValhallaManeuver[];
  shape: string; // polyline6 encoded
  length: number; // km
  duration: number; // seconds
}

interface ValhallaTrip {
  legs: ValhallaLeg[];
  length?: number;   // km total (older builds put totals here…)
  time?: number;     // seconds total
  summary?: { length: number; time: number }; // …newer builds use trip.summary
  status_message?: string;
  status?: number;
}

interface ValhallaResponse {
  trip: ValhallaTrip;
}

interface ValhallaErrorResponse {
  error?: string;
  error_code?: number;
  status_code?: number;
}

// ---------------------------------------------------------------------------
// Polyline6 decoder
// ---------------------------------------------------------------------------
// Valhalla uses Google Polyline encoding at 1e6 precision (6 decimal places)
// instead of the usual 1e5. The algorithm is identical — only the divisor changes.
//
// Algorithm:
//   For each coordinate pair:
//     1. Read chunks of 5-bit groups until a chunk has its 6th bit unset.
//     2. Combine chunks (LSB first), left-shift by 1, invert if negative.
//     3. Divide by 1e6 and accumulate delta from previous value.

function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    // Decode one varint (latitude delta)
    let result = 0;
    let shift = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlat = result & 1 ? ~(result >> 1) : result >> 1;
    lat += dlat;

    // Decode one varint (longitude delta)
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    const dlng = result & 1 ? ~(result >> 1) : result >> 1;
    lng += dlng;

    coords.push([lng / 1e6, lat / 1e6]); // GeoJSON is [lng, lat]
  }

  return coords;
}

// ---------------------------------------------------------------------------
// Maneuver type map: Valhalla numeric type → human-readable tag
// Reference: https://valhalla.github.io/valhalla/turn-by-turn/api-reference/#maneuvers
// ---------------------------------------------------------------------------
const MANEUVER_TYPE_MAP: Record<number, string> = {
  0: "none",
  1: "start",
  2: "start_right",
  3: "start_left",
  4: "destination",
  5: "destination_right",
  6: "destination_left",
  7: "becomes",
  8: "continue",
  9: "slight_right",
  10: "right",
  11: "sharp_right",
  12: "u_turn_right",
  13: "u_turn_left",
  14: "sharp_left",
  15: "left",
  16: "slight_left",
  17: "ramp_straight",
  18: "ramp_right",
  19: "ramp_left",
  20: "exit_right",
  21: "exit_left",
  22: "stay_straight",
  23: "stay_right",
  24: "stay_left",
  25: "merge",
  26: "roundabout_enter",
  27: "roundabout_exit",
  28: "ferry_enter",
  29: "ferry_exit",
  30: "transit",
  31: "transit_transfer",
  32: "transit_remain_on",
  33: "transit_connection_start",
  34: "transit_connection_transfer",
  35: "transit_connection_destination",
  36: "post_transit_connection_destination",
  37: "merge_right",
  38: "merge_left",
};

function maneuverTypeName(typeNum: number): string {
  return MANEUVER_TYPE_MAP[typeNum] ?? `unknown_${typeNum}`;
}

// ---------------------------------------------------------------------------
// Main client
// ---------------------------------------------------------------------------

export class ValhallaError extends Error {
  constructor(
    message: string,
    public readonly code: "unreachable" | "no_route" | "upstream_error",
    public readonly httpStatus: 502 | 422 | 500
  ) {
    super(message);
    this.name = "ValhallaError";
  }
}

/**
 * Greenway-vs-speed preference. Maps to Valhalla's `use_roads` (0 = avoid roads
 * / prefer bike infra, 1 = tolerate roads). The graph.lua tag mapping is the
 * static foundation that makes greenways cheap; this sets how hard the optimizer
 * leans on it at request time. Default is "comfort" (strongest greenway bias).
 */
export type RoutePreference = "comfort" | "balanced" | "fast";

const USE_ROADS_BY_PREFERENCE: Record<RoutePreference, number> = {
  comfort: 0.05, // strong: take greenways even with a meaningful detour
  balanced: 0.35,
  fast: 0.7, // tolerate arterials for a more direct line
};

export async function getRoute(
  from: [number, number], // [lng, lat]
  to: [number, number],   // [lng, lat]
  vias: [number, number][] = [], // [lng, lat][] — ordered pass-through waypoints
  preference: RoutePreference = "comfort"
): Promise<RouteResult> {
  const body = {
    // start/end are "break" stops; vias are "through" so the route passes
    // through each (in order) without stopping or U-turning — this is what
    // powers drag-to-reshape: each dragged point becomes a through waypoint.
    locations: [
      { lon: from[0], lat: from[1], type: "break" },
      ...vias.map(([lon, lat]) => ({ lon, lat, type: "through" })),
      { lon: to[0], lat: to[1], type: "break" },
    ],
    costing: "bicycle",
    costing_options: {
      bicycle: {
        bicycle_type: "Hybrid",
        use_roads: USE_ROADS_BY_PREFERENCE[preference],
        use_hills: 0.5,
      },
    },
    directions_options: { units: "kilometers" },
    shape_match: "edge_walk",
  };

  let res: Response;
  try {
    res = await fetch(`${config.valhallaUrl}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValhallaError(
      `Valhalla unreachable: ${message}`,
      "unreachable",
      502
    );
  }

  if (!res.ok) {
    let errBody: ValhallaErrorResponse = {};
    try {
      errBody = (await res.json()) as ValhallaErrorResponse;
    } catch {
      // ignore parse failure
    }

    // Valhalla returns 400 when no route can be found
    if (res.status === 400 || errBody.error_code === 442) {
      throw new ValhallaError(
        errBody.error ?? "No route found between the given locations",
        "no_route",
        422
      );
    }

    throw new ValhallaError(
      errBody.error ?? `Valhalla returned HTTP ${res.status}`,
      "upstream_error",
      502
    );
  }

  let data: ValhallaResponse;
  try {
    data = (await res.json()) as ValhallaResponse;
  } catch {
    throw new ValhallaError("Valhalla returned invalid JSON", "upstream_error", 502);
  }

  const trip = data.trip;
  if (!trip?.legs?.length) {
    throw new ValhallaError("Valhalla response contained no route legs", "no_route", 422);
  }

  // Decode the full geometry from the first (and usually only) leg.
  // Multi-leg trips are flattened — the shape covers the whole route.
  const allCoords: [number, number][] = [];
  const steps: RouteStep[] = [];

  // Accumulate greenway-equivalent distance to compute coverage. Valhalla can't
  // return our custom class, so each maneuver's class is recovered by spatially
  // matching its shape slice against the classified PBOT network.
  let greenwayMeters = 0;

  for (const leg of trip.legs) {
    const legCoords = decodePolyline6(leg.shape);

    if (allCoords.length === 0) {
      allCoords.push(...legCoords);
    } else {
      // Skip the first point of subsequent legs — it duplicates the last point
      allCoords.push(...legCoords.slice(1));
    }

    for (const maneuver of leg.maneuvers) {
      const stepCoord = legCoords[maneuver.begin_shape_index] ?? legCoords[0];

      // The maneuver spans shape indices [begin, end]; classify by the dominant
      // PBOT class along that slice.
      const slice = legCoords.slice(
        maneuver.begin_shape_index,
        maneuver.end_shape_index + 1
      );
      const cls = dominantClass(slice);
      const distance_m = Math.round(maneuver.length * 1000);
      if (isGreenwayEquivalent(cls)) greenwayMeters += distance_m;

      steps.push({
        instruction: maneuver.instruction,
        distance_m,
        duration_s: Math.round(maneuver.time),
        street_name: maneuver.street_names?.[0] ?? null,
        maneuver_type: maneuverTypeName(maneuver.type),
        location: stepCoord,
        bicycle_network_class: cls,
      });
    }
  }

  const distance_m = Math.round((trip.summary?.length ?? trip.length ?? 0) * 1000);

  return {
    geometry: {
      type: "LineString",
      coordinates: allCoords,
    },
    steps,
    distance_m,
    duration_s: Math.round(trip.summary?.time ?? trip.time ?? 0),
    greenway_coverage: distance_m > 0 ? greenwayMeters / distance_m : 0,
  };
}

// ---------------------------------------------------------------------------
// Map-matching: snap a freehand drawn trace onto the network
// ---------------------------------------------------------------------------
// Used by the iOS finger-draw flow. The user drags a rough path; we hand the
// decimated coordinates to Valhalla /trace_route with shape_match=map_snap and
// bicycle costing, so the snapped result follows real edges and — because the
// tiles are PBOT-greenway-tuned — prefers greenways.
//
// trace_route returns the same { trip: { legs[], length, time } } shape as
// /route, so geometry decoding mirrors getRoute exactly. We skip maneuver
// parsing — the draw flow only needs geometry + total distance.

export interface MatchResult {
  geometry: GeoJSONLineString;
  distance_m: number;
  duration_s: number;
}

export async function matchTrace(
  trace: [number, number][], // [lng, lat][] — the decimated finger path
  anchors?: { from?: [number, number]; to?: [number, number]; follow?: boolean }
): Promise<MatchResult> {
  // Pin the snapped line to the exact start/end markers when provided, so the
  // route begins/ends at the user's pins rather than the first/last drawn point.
  const shape: { lat: number; lon: number }[] = [];
  if (anchors?.from) shape.push({ lat: anchors.from[1], lon: anchors.from[0] });
  for (const [lng, lat] of trace) shape.push({ lat, lon: lng });
  if (anchors?.to) shape.push({ lat: anchors.to[1], lon: anchors.to[0] });

  // Freehand draw (default): strongly prefer bike infra (use_roads 0.1), tight
  // search radius. Hand-edit re-snap (follow=true): the user deliberately dragged
  // the line somewhere, so raise use_roads to follow them onto whatever road is
  // nearest (incl. arterials) and widen the search radius to honor bigger drags.
  const follow = anchors?.follow ?? false;

  const body = {
    shape,
    costing: "bicycle",
    costing_options: {
      bicycle: {
        bicycle_type: "Hybrid",
        use_roads: follow ? 0.5 : 0.1,
        use_hills: 0.5,
      },
    },
    // map_snap loosely matches a sloppy freehand trace to the network.
    shape_match: "map_snap",
    trace_options: {
      search_radius: follow ? 80 : 50, // meters — tolerate finger imprecision / bigger drags
      gps_accuracy: 30,
      turn_penalty_factor: 200, // discourage zig-zag across parallel edges
      breakage_distance: 2000, // allow gaps between sparse drawn points
    },
    directions_options: { units: "kilometers" },
  };

  let res: Response;
  try {
    res = await fetch(`${config.valhallaUrl}/trace_route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValhallaError(`Valhalla unreachable: ${message}`, "unreachable", 502);
  }

  if (!res.ok) {
    let errBody: ValhallaErrorResponse = {};
    try {
      errBody = (await res.json()) as ValhallaErrorResponse;
    } catch {
      // ignore parse failure
    }

    // Valhalla returns 400 when the trace can't be matched to the network.
    if (res.status === 400 || errBody.error_code === 442) {
      throw new ValhallaError(
        errBody.error ?? "Couldn't match that path to a bike route — try drawing closer to the green routes",
        "no_route",
        422
      );
    }

    throw new ValhallaError(
      errBody.error ?? `Valhalla returned HTTP ${res.status}`,
      "upstream_error",
      502
    );
  }

  let data: ValhallaResponse;
  try {
    data = (await res.json()) as ValhallaResponse;
  } catch {
    throw new ValhallaError("Valhalla returned invalid JSON", "upstream_error", 502);
  }

  const trip = data.trip;
  if (!trip?.legs?.length) {
    throw new ValhallaError("Valhalla response contained no matched legs", "no_route", 422);
  }

  // Concatenate leg geometries (skip the duplicated first point of later legs).
  const allCoords: [number, number][] = [];
  for (const leg of trip.legs) {
    const legCoords = decodePolyline6(leg.shape);
    if (allCoords.length === 0) {
      allCoords.push(...legCoords);
    } else {
      allCoords.push(...legCoords.slice(1));
    }
  }

  // Totals live in trip.summary on newer Valhalla builds and at the top level
  // on older ones — read whichever is present.
  const lengthKm = trip.summary?.length ?? trip.length ?? 0;
  const timeS = trip.summary?.time ?? trip.time ?? 0;

  return {
    geometry: { type: "LineString", coordinates: allCoords },
    distance_m: Math.round(lengthKm * 1000),
    duration_s: Math.round(timeS),
  };
}

// ---------------------------------------------------------------------------
// Name a route geometry via Valhalla trace_route
// ---------------------------------------------------------------------------
// BRouter picks the (greenway-preferring) route but its data has no street
// names. We map-match BRouter's geometry onto Valhalla's graph with
// /trace_route to recover turn-by-turn maneuvers WITH street names + turn text,
// then attach our PBOT greenway class per step. Best-effort: the caller falls
// back to class-only steps if this throws.

export async function traceRouteSteps(
  coords: [number, number][] // [lng, lat] route geometry to name
): Promise<RouteStep[]> {
  const body = {
    shape: coords.map(([lng, lat]) => ({ lat, lon: lng })),
    costing: "bicycle",
    costing_options: { bicycle: { bicycle_type: "Hybrid", use_roads: 0.5 } },
    // Tight match so it follows BRouter's line rather than re-routing.
    shape_match: "map_snap",
    trace_options: { search_radius: 20, gps_accuracy: 8, breakage_distance: 2000 },
    directions_options: { units: "kilometers" },
  };

  const res = await fetch(`${config.valhallaUrl}/trace_route`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new ValhallaError(`trace_route HTTP ${res.status}`, "upstream_error", 502);

  const data = (await res.json()) as ValhallaResponse;
  const trip = data.trip;
  if (!trip?.legs?.length) throw new ValhallaError("no matched legs", "no_route", 422);

  const steps: RouteStep[] = [];
  for (const leg of trip.legs) {
    const legCoords = decodePolyline6(leg.shape);
    for (const m of leg.maneuvers) {
      const stepCoord = legCoords[m.begin_shape_index] ?? legCoords[0];
      const slice = legCoords.slice(m.begin_shape_index, m.end_shape_index + 1);
      steps.push({
        instruction: m.instruction,
        distance_m: Math.round(m.length * 1000),
        duration_s: Math.round(m.time),
        street_name: m.street_names?.[0] ?? null,
        maneuver_type: maneuverTypeName(m.type),
        location: stepCoord,
        bicycle_network_class: dominantClass(slice),
      });
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Corridor resolution: turn two tapped points into an ordered chain of vias
// ---------------------------------------------------------------------------
// "Route through this section": the user taps point A then point B on a street;
// we resolve the literal ground path between them and sample it into ordered
// pass-through points. Those points are then injected as `via`s into the master
// /route call, which forces the bike route to traverse that street (through-
// waypoints are mandatory) while the from→corridor and corridor→to legs stay
// normally bike-optimized.
//
// Costing is "pedestrian" — the most permissive "follow the ground between two
// close taps": it won't avoid arterials (unlike bicycle costing) and routes on
// paths/sidewalks too, so it hugs whatever street the user actually tapped.

export interface CorridorResult {
  /** Ordered [lng,lat] pass-through points sampled along the street. */
  points: [number, number][];
  /** The full resolved street geometry (for the highlight preview). */
  geometry: GeoJSONLineString;
}

/** Distance in metres between two [lng,lat] points (equirectangular, city-scale). */
function corridorDistM(a: [number, number], b: [number, number]): number {
  const mLat = 111_320;
  const mLng = 111_320 * Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  return Math.hypot((a[0] - b[0]) * mLng, (a[1] - b[1]) * mLat);
}

/**
 * Sample a polyline to ~1 point every `spacingM` metres, always keeping the
 * first and last vertex. If that would exceed `maxPoints`, the spacing is
 * widened so the cap is never breached.
 */
function sampleAlong(
  coords: [number, number][],
  spacingM: number,
  maxPoints: number
): [number, number][] {
  if (coords.length <= 2) return coords.slice();

  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) total += corridorDistM(coords[i], coords[i + 1]);

  // Widen spacing if needed so we stay within the cap (interior points only).
  const interiorCap = Math.max(1, maxPoints - 2);
  const spacing = Math.max(spacingM, total / (interiorCap + 1));

  const out: [number, number][] = [coords[0]];
  let acc = 0;
  let nextAt = spacing;
  for (let i = 0; i < coords.length - 1; i++) {
    const segLen = corridorDistM(coords[i], coords[i + 1]);
    while (acc + segLen >= nextAt && out.length < maxPoints - 1) {
      const t = (nextAt - acc) / segLen;
      out.push([
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
      ]);
      nextAt += spacing;
    }
    acc += segLen;
  }
  out.push(coords[coords.length - 1]);
  return out;
}

export async function resolveCorridor(
  a: [number, number], // [lng, lat] — first tap
  b: [number, number], // [lng, lat] — second tap
  spacingM = 110,
  maxPoints = 40
): Promise<CorridorResult> {
  const body = {
    locations: [
      { lon: a[0], lat: a[1], type: "break" },
      { lon: b[0], lat: b[1], type: "break" },
    ],
    costing: "pedestrian",
    directions_options: { units: "kilometers" },
    shape_match: "edge_walk",
  };

  let res: Response;
  try {
    res = await fetch(`${config.valhallaUrl}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValhallaError(`Valhalla unreachable: ${message}`, "unreachable", 502);
  }

  if (!res.ok) {
    let errBody: ValhallaErrorResponse = {};
    try {
      errBody = (await res.json()) as ValhallaErrorResponse;
    } catch {
      // ignore parse failure
    }
    if (res.status === 400 || errBody.error_code === 442) {
      throw new ValhallaError(
        "Couldn't find a street between those two points — try tapping closer together along one road",
        "no_route",
        422
      );
    }
    throw new ValhallaError(
      errBody.error ?? `Valhalla returned HTTP ${res.status}`,
      "upstream_error",
      502
    );
  }

  let data: ValhallaResponse;
  try {
    data = (await res.json()) as ValhallaResponse;
  } catch {
    throw new ValhallaError("Valhalla returned invalid JSON", "upstream_error", 502);
  }

  const trip = data.trip;
  if (!trip?.legs?.length) {
    throw new ValhallaError("No path found between the corridor points", "no_route", 422);
  }

  // Concatenate leg geometries (skip the duplicated first point of later legs).
  const allCoords: [number, number][] = [];
  for (const leg of trip.legs) {
    const legCoords = decodePolyline6(leg.shape);
    if (allCoords.length === 0) {
      allCoords.push(...legCoords);
    } else {
      allCoords.push(...legCoords.slice(1));
    }
  }

  if (allCoords.length < 2) {
    throw new ValhallaError("Corridor path too short to use", "no_route", 422);
  }

  return {
    points: sampleAlong(allCoords, spacingM, maxPoints),
    geometry: { type: "LineString", coordinates: allCoords },
  };
}

/** Lightweight ping to check if Valhalla is up. */
export async function pingValhalla(): Promise<boolean> {
  try {
    const res = await fetch(`${config.valhallaUrl}/status`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
