/**
 * routeEngine.ts — which BRouter engine the planner routes against.
 *
 * Mirrors iOS RoutingEngine (RouteStore.swift): same raw values, same labels,
 * persisted across sessions. The raw value is sent to the server as `engine`.
 * "selfbuild" is the default (door-zone avoidance + PBOT quiet streets + 2024–26
 * built lanes prod can't see); "prod" (stock brouter.de) stays available behind
 * the Settings menu for testing. KEEP IN SYNC WITH iOS.
 */

import type { RouteEngine } from "./types";

/** Engines in picker order. */
export const ROUTE_ENGINES: readonly RouteEngine[] = ["selfbuild", "prod"];

/** Short toggle label (KEEP IN SYNC WITH iOS RoutingEngine.label). */
export const ROUTE_ENGINE_LABEL: Record<RouteEngine, string> = {
  selfbuild: "Self-build",
  prod: "Prod",
};

/** One-line helper text shown under the toggle. */
export const ROUTE_ENGINE_HINT: Record<RouteEngine, string> = {
  selfbuild: "Self-built tiles — avoids door-zone lanes, knows new bike lanes (default)",
  prod: "Stock brouter.de tiles — for comparison/testing",
};

const STORAGE_KEY = "bikenice.routeEngine";
const DEFAULT: RouteEngine = "selfbuild";

function isEngine(v: unknown): v is RouteEngine {
  return (
    typeof v === "string" && (ROUTE_ENGINES as readonly string[]).includes(v)
  );
}

/** Load the saved engine, or "selfbuild" if none/invalid. Safe in SSR/no-storage. */
export function loadRouteEngine(): RouteEngine {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isEngine(raw)) return raw;
  } catch {
    /* storage disabled — fall through to default */
  }
  return DEFAULT;
}

/** Persist the chosen engine (best-effort). */
export function saveRouteEngine(engine: RouteEngine): void {
  try {
    localStorage.setItem(STORAGE_KEY, engine);
  } catch {
    /* storage full / disabled — the in-memory state still drives routing */
  }
}
