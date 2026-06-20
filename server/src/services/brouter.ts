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
import { ValhallaError } from "./valhalla.js";
import type { RouteResult } from "./valhalla.js";
import { assembleRouteFromGeometry } from "./route-synth.js";

/** comfort↔fast preference → BRouter profile. `safety` won the greenway A/B. */
const PROFILE_BY_PREFERENCE: Record<string, string> = {
  comfort: "safety",
  balanced: "trekking",
  fast: "fastbike",
};

interface BrouterGeoJSON {
  features?: Array<{
    properties?: Record<string, string>;
    geometry?: { type: string; coordinates: number[][] };
  }>;
}

export async function getRouteBrouter(
  from: [number, number], // [lng, lat]
  to: [number, number], // [lng, lat]
  vias: [number, number][] = [],
  preference: string = "comfort"
): Promise<RouteResult> {
  const profile = PROFILE_BY_PREFERENCE[preference] ?? "safety";
  const lonlats = [from, ...vias, to]
    .map(([lng, lat]) => `${lng},${lat}`)
    .join("|");
  const url =
    `${config.brouterUrl}/brouter?lonlats=${encodeURIComponent(lonlats)}` +
    `&profile=${profile}&alternativeidx=0&format=geojson`;

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

  // Coverage + steps are synthesized from BRouter's geometry (shared with ORS /
  // GraphHopper so the metric stays comparable engine-to-engine).
  return assembleRouteFromGeometry(coords, distance_m, duration_s);
}
