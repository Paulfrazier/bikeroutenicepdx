/**
 * GraphHopper routing client — a bake-off contender.
 *
 * GraphHopper's `bike` profile is a well-tuned OSM bike router. Free public API,
 * key required (no billing, ~500 requests/day on the free tier — the tightest
 * quota of the four engines, hence the bake-off cache).
 *
 * With points_encoded=false it returns plain [lng,lat] geometry, so steps +
 * coverage are synthesized via the shared route-synth helper (names from the
 * Valhalla map-match).
 *
 * On a missing key or HTTP 429 (daily quota), throws EngineSkip so the bake-off
 * drops GraphHopper for that request rather than failing the route.
 */

import { config } from "../../config.js";
import { ValhallaError } from "../../services/valhalla.js";
import type { RouteResult } from "../../services/valhalla.js";
import { assembleRouteFromGeometry } from "./route-synth.js";
import { EngineSkip } from "./engine-skip.js";

interface GraphHopperResponse {
  paths?: Array<{
    distance?: number; // meters
    time?: number; // milliseconds
    points?: { type: string; coordinates: number[][] }; // GeoJSON when points_encoded=false
  }>;
  message?: string;
}

export async function getRouteGraphHopper(
  from: [number, number], // [lng, lat]
  to: [number, number], // [lng, lat]
  vias: [number, number][] = [],
  _preference: string = "comfort"
): Promise<RouteResult> {
  if (!config.graphhopperApiKey) {
    throw new EngineSkip("graphhopper", "no GRAPHHOPPER_API_KEY configured");
  }

  // point=lat,lng (GraphHopper order), one per stop, in order.
  const params = new URLSearchParams();
  for (const [lng, lat] of [from, ...vias, to]) params.append("point", `${lat},${lng}`);
  params.set("profile", "bike");
  params.set("points_encoded", "false");
  params.set("locale", "en");
  params.set("key", config.graphhopperApiKey);

  const url = `${config.graphhopperUrl}/api/1/route?${params.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValhallaError(`GraphHopper unreachable: ${message}`, "unreachable", 502);
  }

  // Free-tier quota exhausted / rate limited → skip this request.
  if (res.status === 429) {
    throw new EngineSkip("graphhopper", "GraphHopper rate limited (HTTP 429)");
  }

  const text = await res.text();
  if (!res.ok) {
    let msg = `GraphHopper HTTP ${res.status}`;
    try {
      msg = (JSON.parse(text) as GraphHopperResponse).message ?? msg;
    } catch {
      // non-JSON error body
    }
    // 400 with no route between points is a routing failure, not an outage.
    const code = res.status === 400 ? "no_route" : "upstream_error";
    throw new ValhallaError(msg.slice(0, 200), code, code === "no_route" ? 422 : 502);
  }

  let data: GraphHopperResponse;
  try {
    data = JSON.parse(text) as GraphHopperResponse;
  } catch {
    throw new ValhallaError("GraphHopper returned invalid JSON", "upstream_error", 502);
  }

  const path = data.paths?.[0];
  if (!path?.points?.coordinates?.length) {
    throw new ValhallaError("GraphHopper returned no route geometry", "no_route", 422);
  }

  const coords: [number, number][] = path.points.coordinates.map((c) => [c[0], c[1]]);
  const distance_m = Math.round(Number(path.distance ?? 0));
  const duration_s = Math.round(Number(path.time ?? 0) / 1000); // ms → s

  return assembleRouteFromGeometry(coords, distance_m, duration_s);
}
