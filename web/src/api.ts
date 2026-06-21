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
