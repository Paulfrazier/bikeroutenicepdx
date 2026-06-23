/**
 * Typed API client for the BikeRouteNicePDX backend.
 *
 * Base URL comes from VITE_API_URL (default /api in dev, which the Vite proxy
 * rewrites to http://localhost:3000).
 */

import type {
  RouteRequest,
  RouteResponse,
  CorridorRequest,
  CorridorResponse,
  SearchResult,
  HealthResponse,
  LngLat,
} from "./types";

const BASE_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "/api";

async function request<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`API ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** POST /route — compute a bike route between two points */
export async function fetchRoute(req: RouteRequest): Promise<RouteResponse> {
  return request<RouteResponse>("/route", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** POST /corridor — resolve the street between two tapped points into ordered vias */
export async function fetchCorridor(
  req: CorridorRequest
): Promise<CorridorResponse> {
  return request<CorridorResponse>("/corridor", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** GET /search?q=...&limit=... — geocode / place search */
export async function searchPlaces(
  q: string,
  limit = 5,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  return request<SearchResult[]>(`/search?${params}`, { signal });
}

/** GET /health */
export async function fetchHealth(): Promise<HealthResponse> {
  return request<HealthResponse>("/health");
}

/** A user-submitted map "fix" (a drawn connector) sent for community review. */
export interface FixSubmitRequest {
  /** The drawn connector polyline ([lng, lat][]). */
  coords: LngLat[];
  /** Optional free-text note (≤500 chars server-side). */
  note?: string;
  /** Optional contact (≤200 chars server-side). */
  contact?: string;
}

/** Server reply to a fix submission. `url` is the created issue's html_url. */
export interface FixSubmitResponse {
  status: string;
  url?: string;
}

/**
 * POST /fix-submit — file a drawn connector for community review.
 * Throws on any non-2xx (503 when the server isn't configured for it); the
 * caller surfaces a friendly "couldn't submit" message.
 */
export async function submitFix(
  req: FixSubmitRequest
): Promise<FixSubmitResponse> {
  return request<FixSubmitResponse>("/fix-submit", {
    method: "POST",
    body: JSON.stringify(req),
  });
}
