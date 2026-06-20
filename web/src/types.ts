// Shared TypeScript types matching the server contract

/** [lng, lat] tuple */
export type LngLat = [number, number];

// ─── /route ─────────────────────────────────────────────────────────────────

export interface RouteRequest {
  from: LngLat;
  to: LngLat;
  /** Ordered pass-through points (Valhalla "through" waypoints) for reshaping. */
  via?: LngLat[];
}

/**
 * A drag-to-reshape waypoint. Unlike the bare `[lng,lat]` sent to the server,
 * this carries a stable `id` (so re-routes never reorder/lose it) and a
 * `precise` flag: precise waypoints are pinned exactly where dropped (never
 * snapped to the network) so the user can force a route through an exact point.
 */
export interface Via {
  id: string;
  at: LngLat;
  precise: boolean;
}

export interface RouteStep {
  instruction: string;
  distance_m: number;
  duration_s: number;
  street_name: string | null;
  maneuver_type: string;
  location: LngLat;
  bicycle_network_class: string | null;
}

export interface RouteGeometry {
  type: "LineString";
  coordinates: LngLat[];
}

export interface RouteResponse {
  geometry: RouteGeometry;
  steps: RouteStep[];
  distance_m: number;
  duration_s: number;
  /** 0–1 fraction of route on off_street | greenway | protected edges */
  greenway_coverage: number;
}

// ─── /search ────────────────────────────────────────────────────────────────

export interface SearchResult {
  name: string;
  lng: number;
  lat: number;
  type: string;
}

// ─── /health ────────────────────────────────────────────────────────────────

export interface HealthResponse {
  status: "ok" | "error";
  valhalla: "ok" | "down";
}

// ─── UI helpers ─────────────────────────────────────────────────────────────

/** Which network class colour category to show in the directions panel */
export type NetworkPillVariant =
  | "greenway"
  | "protected"
  | "residential"
  | "collector"
  | "arterial"
  | "default";

export function networkClassToVariant(
  cls: string | null
): NetworkPillVariant {
  if (!cls) return "default";
  if (cls === "off_street" || cls === "greenway") return "greenway";
  if (cls === "protected" || cls === "buffered") return "protected";
  if (cls === "residential" || cls === "standard") return "residential";
  if (cls === "collector") return "collector";
  if (cls === "arterial" || cls === "arterial_no_bike") return "arterial";
  return "default";
}
