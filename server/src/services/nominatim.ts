/**
 * Nominatim geocoding client, biased to the Portland/Vancouver metro bounding box.
 *
 * Rate limit: Nominatim enforces 1 request per second for the public instance.
 * We enforce this with a simple in-memory token bucket — one token replenished
 * per second, consumed before each outbound request.
 */

import { config } from "../config.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeocodingResult {
  name: string;
  lng: number;
  lat: number;
  type: string;
}

// Nominatim jsonv2 result shape (partial — only what we use)
interface NominatimResult {
  display_name: string;
  lon: string;
  lat: string;
  type: string;
  category: string;
  addresstype?: string;
}

// ---------------------------------------------------------------------------
// Portland metro bounding box
// Nominatim viewbox format: lon_min,lat_max,lon_max,lat_min (unusual — documented)
// SW corner: ~-123.0, 45.3  NE corner: ~-122.3, 45.7
// ---------------------------------------------------------------------------
const PORTLAND_VIEWBOX = "-123.0,45.7,-122.3,45.3";

// User-Agent required by Nominatim usage policy.
// Without it, requests are rate-limited more aggressively.
const USER_AGENT = "BikeRouteNicePDX/0.1 (paulfrazier@gmail.com)";

// ---------------------------------------------------------------------------
// Simple in-memory token bucket (1 rps for public Nominatim)
// ---------------------------------------------------------------------------

let lastRequestAt = 0; // epoch ms of last outbound request

async function acquireRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  if (elapsed < 1000) {
    // Wait out the remainder of the 1-second window
    await new Promise<void>((resolve) => setTimeout(resolve, 1000 - elapsed));
  }
  lastRequestAt = Date.now();
}

// ---------------------------------------------------------------------------
// Nominatim result → our type mapping
// ---------------------------------------------------------------------------

function mapResultType(result: NominatimResult): string {
  const { addresstype, category, type } = result;

  if (addresstype) {
    // addresstype is the most reliable for address-like results
    switch (addresstype) {
      case "house":
      case "building":
        return "address";
      case "road":
      case "path":
      case "footway":
      case "cycleway":
        return "street";
      case "neighbourhood":
      case "suburb":
      case "quarter":
        return "neighborhood";
      case "city":
      case "town":
      case "village":
        return "city";
      case "postcode":
        return "postcode";
    }
  }

  // Fall back to category/type
  if (category === "amenity" || category === "tourism" || category === "shop") {
    return "poi";
  }
  if (category === "place") {
    return type === "neighbourhood" || type === "suburb" ? "neighborhood" : "city";
  }
  if (category === "highway") {
    return "street";
  }

  return type ?? "place";
}

// ---------------------------------------------------------------------------
// Public search function
// ---------------------------------------------------------------------------

export class NominatimError extends Error {
  constructor(
    message: string,
    public readonly code: "unreachable" | "upstream_error",
    public readonly httpStatus: 502
  ) {
    super(message);
    this.name = "NominatimError";
  }
}

export async function geocodeSearch(
  query: string,
  limit: number = 5
): Promise<GeocodingResult[]> {
  await acquireRateLimit();

  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: String(Math.min(limit, 10)),
    viewbox: PORTLAND_VIEWBOX,
    bounded: "1",
    addressdetails: "1",
  });

  let res: Response;
  try {
    res = await fetch(`${config.nominatimUrl}/search?${params.toString()}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NominatimError(
      `Geocoder unreachable: ${message}`,
      "unreachable",
      502
    );
  }

  if (!res.ok) {
    throw new NominatimError(
      `Geocoder returned HTTP ${res.status}`,
      "upstream_error",
      502
    );
  }

  let raw: NominatimResult[];
  try {
    raw = (await res.json()) as NominatimResult[];
  } catch {
    throw new NominatimError("Geocoder returned invalid JSON", "upstream_error", 502);
  }

  return raw.map((r) => ({
    name: r.display_name,
    lng: parseFloat(r.lon),
    lat: parseFloat(r.lat),
    type: mapResultType(r),
  }));
}
