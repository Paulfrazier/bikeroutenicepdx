/**
 * boundary.ts
 *
 * Point-in-polygon clipping for the jurisdiction pipeline.
 *
 * Used by export-bike-network.ts to drop RLIS features that fall inside Portland
 * city limits, so PBOT's fresher, more granular layer (plus the hand-curated
 * new-builds supplement) stays authoritative in-city. See jurisdictions.ts.
 *
 * The Portland boundary is a MultiPolygon with ~16k vertices, and we test ~30k
 * features against it, so a naive ray-cast per feature is ~500M operations. Two
 * cheap wins make it fast: a whole-boundary bbox reject up front (most suburban
 * features never touch the ring math) and a per-ring bbox reject inside.
 */

import * as fs from "fs";
import * as path from "path";

const CITY_BOUNDARIES_URL =
  "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Boundary/MapServer/10";

export type Ring = [number, number][];
type BBox = [number, number, number, number]; // minLon, minLat, maxLon, maxLat

export interface Boundary {
  /** Outer rings with their precomputed bboxes. Holes are ignored — Portland's
   * city limits have no meaningful interior voids for this purpose, and treating
   * a hole as solid only ever over-clips RLIS in a place PBOT already covers. */
  rings: { ring: Ring; bbox: BBox }[];
  bbox: BBox;
}

function ringBBox(ring: Ring): BBox {
  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLon, minLat, maxLon, maxLat];
}

function inBBox(lon: number, lat: number, b: BBox): boolean {
  return lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3];
}

/** Standard even-odd ray cast. Boundary cases don't matter here — a facility
 * exactly on the city line is arbitrary either way. */
function inRing(lon: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function contains(boundary: Boundary, lon: number, lat: number): boolean {
  if (!inBBox(lon, lat, boundary.bbox)) return false;
  for (const { ring, bbox } of boundary.rings) {
    if (!inBBox(lon, lat, bbox)) continue;
    if (inRing(lon, lat, ring)) return true;
  }
  return false;
}

/**
 * Representative point for a line feature: the midpoint of its longest part.
 * Using a vertex rather than an interpolated centroid keeps a curved street from
 * reporting a point that isn't on the street at all.
 */
export function representativePoint(geometry: {
  type: string;
  coordinates: unknown;
}): [number, number] | null {
  const c = geometry.coordinates;
  if (!Array.isArray(c) || c.length === 0) return null;
  let line: unknown[] | null = null;
  if (geometry.type === "LineString") {
    line = c as unknown[];
  } else if (geometry.type === "MultiLineString") {
    for (const part of c as unknown[]) {
      if (Array.isArray(part) && (!line || part.length > line.length)) line = part;
    }
  }
  if (!line || line.length === 0) return null;
  const mid = line[Math.floor(line.length / 2)];
  if (!Array.isArray(mid) || typeof mid[0] !== "number" || typeof mid[1] !== "number") {
    return null;
  }
  return [mid[0], mid[1]];
}

/**
 * Fetch the named city's boundary, caching to `cacheDir` so repeat exports and
 * offline runs don't depend on PortlandMaps being up. The clip is a correctness
 * guard, so a fetch failure with no cache is fatal to the caller, not a warning
 * to skip past — silently skipping would let RLIS overwrite the PBOT supplement.
 */
export async function loadCityBoundary(
  cityName: string,
  cacheDir: string
): Promise<Boundary> {
  const cachePath = path.join(cacheDir, `boundary-${cityName.toLowerCase()}.geojson`);
  let raw: string;

  if (fs.existsSync(cachePath)) {
    raw = fs.readFileSync(cachePath, "utf8");
  } else {
    const params = new URLSearchParams({
      where: `UPPER(CITYNAME)='${cityName.toUpperCase()}'`,
      outFields: "CITYNAME",
      outSR: "4326",
      f: "geojson",
    });
    const res = await fetch(`${CITY_BOUNDARIES_URL}/query?${params.toString()}`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`boundary fetch HTTP ${res.status} for ${cityName}`);
    raw = await res.text();
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(cachePath, raw, "utf8");
  }

  const fc = JSON.parse(raw) as {
    features?: { geometry?: { type: string; coordinates: unknown } }[];
  };
  const rings: { ring: Ring; bbox: BBox }[] = [];

  for (const f of fc.features ?? []) {
    const g = f.geometry;
    if (!g) continue;
    // Polygon: [ring, ...holes]. MultiPolygon: [[ring, ...holes], ...].
    const polys =
      g.type === "Polygon"
        ? [g.coordinates as unknown[]]
        : g.type === "MultiPolygon"
          ? (g.coordinates as unknown[][])
          : [];
    for (const poly of polys) {
      const outer = (poly as unknown[])[0];
      if (!Array.isArray(outer) || outer.length < 4) continue;
      const ring = outer as Ring;
      rings.push({ ring, bbox: ringBBox(ring) });
    }
  }

  if (rings.length === 0) throw new Error(`no polygon rings found for ${cityName}`);

  let minLon = Infinity,
    minLat = Infinity,
    maxLon = -Infinity,
    maxLat = -Infinity;
  for (const { bbox } of rings) {
    if (bbox[0] < minLon) minLon = bbox[0];
    if (bbox[1] < minLat) minLat = bbox[1];
    if (bbox[2] > maxLon) maxLon = bbox[2];
    if (bbox[3] > maxLat) maxLat = bbox[3];
  }

  return { rings, bbox: [minLon, minLat, maxLon, maxLat] };
}
