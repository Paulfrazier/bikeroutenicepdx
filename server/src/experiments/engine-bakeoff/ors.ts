/**
 * OpenRouteService routing client — a bake-off contender.
 *
 * ORS is OSM-based; we use its `cycling-regular` bike profile (the public API's
 * general bike router — there is no `cycling-safe` profile) with the default
 * "recommended" preference, which already biases toward bike-friendly ways.
 * Free public API on HeiGIT, key required (no billing, ~2,000 requests/day).
 *
 * Like BRouter it returns only geometry, so steps + coverage are synthesized
 * via the shared route-synth helper (street names come from Valhalla map-match).
 *
 * On a missing key or HTTP 429 (daily quota), this throws an EngineSkip error so
 * the bake-off drops ORS for that request instead of failing the whole route.
 */

import { config } from "../../config.js";
import { ValhallaError } from "../../services/valhalla.js";
import type { RouteResult } from "../../services/valhalla.js";
import { assembleRouteFromGeometry } from "./route-synth.js";
import { EngineSkip } from "./engine-skip.js";

// ORS bike profile. `preference` is recorded for the bake-off scoring but
// doesn't change the profile (we keep one comparable ORS route per request).
const ORS_PROFILE = "cycling-regular";

interface OrsGeoJSON {
  features?: Array<{
    geometry?: { type: string; coordinates: number[][] };
    properties?: { summary?: { distance?: number; duration?: number } };
  }>;
  error?: { message?: string } | string;
}

export async function getRouteOrs(
  from: [number, number], // [lng, lat]
  to: [number, number], // [lng, lat]
  vias: [number, number][] = [],
  _preference: string = "comfort"
): Promise<RouteResult> {
  if (!config.orsApiKey) {
    throw new EngineSkip("ors", "no ORS_API_KEY configured");
  }

  const coordinates = [from, ...vias, to].map(([lng, lat]) => [lng, lat]);
  const url = `${config.orsUrl}/v2/directions/${ORS_PROFILE}/geojson`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: config.orsApiKey,
        "Content-Type": "application/json",
        Accept: "application/geo+json",
      },
      body: JSON.stringify({ coordinates }),
      signal: AbortSignal.timeout(6000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValhallaError(`ORS unreachable: ${message}`, "unreachable", 502);
  }

  // Quota exhausted / rate limited → skip ORS this request, don't fail the route.
  if (res.status === 429) {
    throw new EngineSkip("ors", "ORS rate limited (HTTP 429)");
  }

  const text = await res.text();
  if (!res.ok) {
    throw new ValhallaError(
      text.slice(0, 200) || `ORS HTTP ${res.status}`,
      "upstream_error",
      502
    );
  }

  let data: OrsGeoJSON;
  try {
    data = JSON.parse(text) as OrsGeoJSON;
  } catch {
    throw new ValhallaError("ORS returned invalid JSON", "upstream_error", 502);
  }

  const feat = data.features?.[0];
  if (!feat?.geometry?.coordinates?.length) {
    throw new ValhallaError("ORS returned no route geometry", "no_route", 422);
  }

  // ORS coords are [lng, lat] (occasionally with elevation) — keep lng/lat.
  const coords: [number, number][] = feat.geometry.coordinates.map((c) => [c[0], c[1]]);
  const distance_m = Math.round(Number(feat.properties?.summary?.distance ?? 0));
  const duration_s = Math.round(Number(feat.properties?.summary?.duration ?? 0));

  return assembleRouteFromGeometry(coords, distance_m, duration_s);
}
