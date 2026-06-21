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
  /** Secondary line (neighborhood, city) — optional, for two-line display. */
  context?: string;
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
  /** OSM feature name (POIs, named places). */
  name?: string;
  /** Present because we request addressdetails=1. */
  address?: Record<string, string>;
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
// In-memory result cache (TTL + LRU)
//
// Checked BEFORE the rate limiter, so a cache hit returns instantly and skips
// the up-to-1s rate-limit wait entirely. This is the single biggest perceived
// speedup for repeated / backspace-and-retype queries.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  results: GeocodingResult[];
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(query: string, limit: number): string {
  return `${query.trim().toLowerCase()}|${limit}`;
}

function cacheGet(key: string): GeocodingResult[] | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU recency: re-insert at the tail.
  cache.delete(key);
  cache.set(key, entry);
  return entry.results;
}

function cacheSet(key: string, results: GeocodingResult[]): void {
  cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
  // Evict oldest entries (Map preserves insertion order) past the cap.
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
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
// Concise label builder
//
// Nominatim's display_name is verbose, e.g.
//   "3703, Northeast 22nd Avenue, Irvington, Portland, Multnomah County, Oregon, 97212, United States"
// We split it into a short primary line ("3703 NE 22nd Ave") and a secondary
// context line ("Irvington, Portland"), dropping county / state / ZIP / country.
// ---------------------------------------------------------------------------

const CARDINAL_ABBR: Array<[RegExp, string]> = [
  [/\bNortheast\b/gi, "NE"],
  [/\bNorthwest\b/gi, "NW"],
  [/\bSoutheast\b/gi, "SE"],
  [/\bSouthwest\b/gi, "SW"],
  [/\bNorth\b/gi, "N"],
  [/\bSouth\b/gi, "S"],
  [/\bEast\b/gi, "E"],
  [/\bWest\b/gi, "W"],
];

const STREET_SUFFIX_ABBR: Array<[RegExp, string]> = [
  [/\bAvenue\b/gi, "Ave"],
  [/\bStreet\b/gi, "St"],
  [/\bBoulevard\b/gi, "Blvd"],
  [/\bDrive\b/gi, "Dr"],
  [/\bRoad\b/gi, "Rd"],
  [/\bCourt\b/gi, "Ct"],
  [/\bPlace\b/gi, "Pl"],
  [/\bLane\b/gi, "Ln"],
  [/\bTerrace\b/gi, "Ter"],
  [/\bParkway\b/gi, "Pkwy"],
  [/\bHighway\b/gi, "Hwy"],
];

function shorten(value: string): string {
  let out = value;
  for (const [re, abbr] of CARDINAL_ABBR) out = out.replace(re, abbr);
  for (const [re, abbr] of STREET_SUFFIX_ABBR) out = out.replace(re, abbr);
  return out.trim();
}

function buildLabel(result: NominatimResult): { name: string; context?: string } {
  const addr = result.address ?? {};

  const road = addr.road ?? addr.pedestrian ?? addr.footway ?? addr.cycleway ?? addr.path;
  const houseNumber = addr.house_number;
  // OSM feature name (POIs, parks, named places — and roads, where it duplicates `road`).
  const place =
    result.name ||
    addr.amenity ||
    addr.shop ||
    addr.tourism ||
    addr.building ||
    addr.leisure;

  const isStreet = mapResultType(result) === "street";

  function firstSegment(): string {
    const segments = result.display_name.split(",").map((s) => s.trim());
    return segments.find((s) => s && !/^\d+$/.test(s)) ?? segments[0] ?? result.display_name;
  }

  let name: string;
  if (isStreet) {
    // Always abbreviate street names (Southeast Hawthorne Boulevard → SE Hawthorne Blvd).
    name = shorten(road ?? place ?? firstSegment());
  } else if (houseNumber && road) {
    name = shorten(`${houseNumber} ${road}`);
  } else if (place) {
    // POI / park / named place — keep verbatim (no cardinal abbreviation).
    name = place;
  } else if (road) {
    name = shorten(road);
  } else {
    name = shorten(firstSegment());
  }

  // City-ish line: prefer neighborhood, then the municipality. Drop any part
  // that just repeats the name (e.g. the "Alberta" neighborhood in Alberta).
  const neighborhood = addr.neighbourhood ?? addr.suburb ?? addr.quarter;
  const city = addr.city ?? addr.town ?? addr.village ?? addr.hamlet ?? addr.municipality;
  const contextParts = [...new Set([neighborhood, city])].filter(
    (p): p is string => Boolean(p) && p !== name
  );
  const context = contextParts.length > 0 ? contextParts.join(", ") : undefined;

  return { name, context };
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
  const key = cacheKey(query, limit);
  const cached = cacheGet(key);
  if (cached) return cached;

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

  const results: GeocodingResult[] = raw.map((r) => {
    const { name, context } = buildLabel(r);
    return {
      name,
      context,
      lng: parseFloat(r.lon),
      lat: parseFloat(r.lat),
      type: mapResultType(r),
    };
  });

  cacheSet(key, results);
  return results;
}
