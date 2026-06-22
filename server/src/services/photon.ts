/**
 * Photon (komoot) geocoding client — the as-you-type autocomplete backend.
 *
 * Why Photon over Nominatim for autocomplete:
 *  - It is purpose-built for typeahead: fuzzy *prefix* matching, so a half-typed
 *    address ("3703 NE 22") returns useful results instead of nothing.
 *  - It supports a `lat`/`lon` proximity bias, so Portland results rank first
 *    ("predict Portland") — Nominatim only restricts by bbox, it doesn't rank by
 *    distance.
 *  - The public instance is built to be hit per-keystroke, so we do NOT impose
 *    the artificial 1-rps serializer that Nominatim's usage policy requires. That
 *    serializer was the single biggest source of perceived autocomplete latency.
 *
 * Nominatim stays as the fallback (see routes/search.ts) for when Photon errors.
 */

import { config } from "../config.js";
import { shorten, type GeocodingResult } from "./nominatim.js";

// ---------------------------------------------------------------------------
// Portland metro bias + bounds
//
// `lat`/`lon` is a proximity *bias* (affects ranking), `bbox` is a hard filter.
// Photon bbox order is the GeoJSON-standard minLon,minLat,maxLon,maxLat — note
// this differs from Nominatim's viewbox (lon_min,lat_max,lon_max,lat_min).
// ---------------------------------------------------------------------------
const PORTLAND_CENTER = { lat: 45.5231, lon: -122.6765 }; // downtown-ish centroid
const PORTLAND_BBOX = "-123.0,45.3,-122.3,45.7"; // minLon,minLat,maxLon,maxLat

const USER_AGENT = "BikeRouteNicePDX/0.1 (paulfrazier@gmail.com)";

// ---------------------------------------------------------------------------
// In-memory result cache (TTL + LRU) — mirrors the Nominatim cache so repeated /
// backspace-and-retype queries return instantly.
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
  cache.delete(key);
  cache.set(key, entry);
  return entry.results;
}

function cacheSet(key: string, results: GeocodingResult[]): void {
  cache.set(key, { results, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------
// Photon GeoJSON response shape (partial — only what we use)
// ---------------------------------------------------------------------------

interface PhotonFeature {
  geometry: { type: "Point"; coordinates: [number, number] }; // [lon, lat]
  properties: {
    osm_key?: string; // e.g. "highway", "place", "leisure", "amenity", "building"
    osm_value?: string; // e.g. "residential", "park", "cafe"
    /** Photon's own classification: house | street | locality | district | city | … */
    type?: string;
    name?: string; // named feature (POI / park / place)
    housenumber?: string;
    street?: string;
    district?: string; // neighborhood
    city?: string;
    county?: string;
    state?: string;
    postcode?: string;
    countrycode?: string;
  };
}

interface PhotonResponse {
  type: "FeatureCollection";
  features: PhotonFeature[];
}

export class PhotonError extends Error {
  constructor(
    message: string,
    public readonly code: "unreachable" | "upstream_error"
  ) {
    super(message);
    this.name = "PhotonError";
  }
}

// ---------------------------------------------------------------------------
// Photon result → our type mapping
// ---------------------------------------------------------------------------

function mapResultType(p: PhotonFeature["properties"]): string {
  const { osm_key, osm_value, type } = p;

  if (type === "house") return "address";
  if (type === "street" || osm_key === "highway") return "street";

  // POIs: surface the specific kind (park, cafe, pharmacy…) as the badge.
  // "yes" is a useless OSM placeholder; humanize snake_case.
  if (
    osm_key === "leisure" ||
    osm_key === "amenity" ||
    osm_key === "tourism" ||
    osm_key === "shop"
  ) {
    return osm_value && osm_value !== "yes" ? osm_value.replace(/_/g, " ") : "poi";
  }

  if (type === "district" || type === "locality" || osm_key === "place") {
    if (osm_value === "neighbourhood" || osm_value === "suburb" || osm_value === "quarter") {
      return "neighborhood";
    }
    if (type === "district" || type === "locality") return "neighborhood";
    return "city";
  }
  if (type === "city") return "city";
  if (type === "postcode") return "postcode";

  return osm_value?.replace(/_/g, " ") ?? type ?? "place";
}

// ---------------------------------------------------------------------------
// Concise label builder — primary line + secondary context, mirroring the
// Nominatim labeler so both backends produce identical-looking results.
// ---------------------------------------------------------------------------

function buildLabel(p: PhotonFeature["properties"]): { name: string; context?: string } {
  const street = p.street;
  const houseNumber = p.housenumber;
  const isStreet = mapResultType(p) === "street";
  const isHouse = p.type === "house";

  // A named feature is a POI / park / named place whose own name is the primary line.
  const isNamedFeature = !isStreet && !isHouse && !!p.name;

  const streetAddress =
    houseNumber && street ? shorten(`${houseNumber} ${street}`) : street ? shorten(street) : undefined;

  let name: string;
  if (isStreet) {
    name = shorten(street ?? p.name ?? "");
  } else if (isNamedFeature) {
    name = p.name!; // keep verbatim — no cardinal abbreviation for POIs
  } else if (streetAddress) {
    name = streetAddress;
  } else if (p.name) {
    name = p.name;
  } else {
    name = p.city ?? p.district ?? "";
  }

  const neighborhood = p.district;
  const city = p.city;
  const contextParts = [isNamedFeature ? streetAddress : undefined, neighborhood, city].filter(
    (s): s is string => Boolean(s)
  );
  const context = [...new Set(contextParts)].filter((s) => s !== name).join(", ") || undefined;

  return { name: name || (context ?? ""), context };
}

function reorderByHouseNumber(features: PhotonFeature[], query: string): PhotonFeature[] {
  const m = query.match(/^\s*(\d+)\b/);
  if (!m) return features;
  const wanted = m[1];
  const matches = features.filter((f) => f.properties.housenumber === wanted);
  if (matches.length === 0) return features;
  const rest = features.filter((f) => f.properties.housenumber !== wanted);
  return [...matches, ...rest];
}

// ---------------------------------------------------------------------------
// Public search function
// ---------------------------------------------------------------------------

export async function photonSearch(
  query: string,
  limit: number = 5
): Promise<GeocodingResult[]> {
  const key = cacheKey(query, limit);
  const cached = cacheGet(key);
  if (cached) return cached;

  const params = new URLSearchParams({
    q: query,
    lang: "en",
    limit: String(Math.min(limit, 10)),
    lat: String(PORTLAND_CENTER.lat),
    lon: String(PORTLAND_CENTER.lon),
    bbox: PORTLAND_BBOX,
  });

  let res: Response;
  try {
    res = await fetch(`${config.photonUrl}/api?${params.toString()}`, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(4000),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PhotonError(`Photon unreachable: ${message}`, "unreachable");
  }

  if (!res.ok) {
    throw new PhotonError(`Photon returned HTTP ${res.status}`, "upstream_error");
  }

  let raw: PhotonResponse;
  try {
    raw = (await res.json()) as PhotonResponse;
  } catch {
    throw new PhotonError("Photon returned invalid JSON", "upstream_error");
  }

  // Photon occasionally ranks a house-number-less fuzzy match (e.g. a street in
  // the wrong city) above the exact address when the full string is typed. If the
  // query leads with a house number, float features whose housenumber matches it
  // to the top — stable, so Photon's relevance order is otherwise preserved.
  const features = reorderByHouseNumber(raw.features ?? [], query);

  const results: GeocodingResult[] = features.map((f) => {
    const { name, context } = buildLabel(f.properties);
    const [lng, lat] = f.geometry.coordinates;
    return { name, context, lng, lat, type: mapResultType(f.properties) };
  });

  cacheSet(key, results);
  return results;
}
