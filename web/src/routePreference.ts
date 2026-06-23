/**
 * routePreference.ts — the greenway-vs-speed tier the planner routes with.
 *
 * Mirrors iOS RoutePreference (RouteStore.swift): same raw values, same order,
 * same labels, persisted across sessions. The raw value is sent to the server as
 * `preference` and mapped there to a BRouter profile, so a tier picked on web or
 * iOS routes identically. KEEP IN SYNC WITH iOS.
 */

import type { RoutePreference } from "./types";

/** Tiers in slider order: most-comfortable → fastest. */
export const ROUTE_PREFERENCES: readonly RoutePreference[] = [
  "ultra",
  "comfort",
  "balanced",
  "fast",
];

/** Short segmented-control label (KEEP IN SYNC WITH iOS RoutePreference.label). */
export const ROUTE_PREFERENCE_LABEL: Record<RoutePreference, string> = {
  ultra: "Ultra",
  comfort: "Comfort",
  balanced: "Balanced",
  fast: "Fast",
};

/** One-line helper text shown under the picker. */
export const ROUTE_PREFERENCE_HINT: Record<RoutePreference, string> = {
  ultra: "Greenways above all — detours to stay off busy streets",
  comfort: "Prefers greenways and calm streets (default)",
  balanced: "A reasonable mix of calm and direct",
  fast: "Most direct — uses bigger roads when quicker",
};

const STORAGE_KEY = "bikenice.routePreference";
const DEFAULT: RoutePreference = "comfort";

function isPreference(v: unknown): v is RoutePreference {
  return (
    typeof v === "string" &&
    (ROUTE_PREFERENCES as readonly string[]).includes(v)
  );
}

/** Load the saved tier, or "comfort" if none/invalid. Safe in SSR/no-storage. */
export function loadRoutePreference(): RoutePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (isPreference(raw)) return raw;
  } catch {
    /* storage disabled — fall through to default */
  }
  return DEFAULT;
}

/** Persist the chosen tier (best-effort). */
export function saveRoutePreference(pref: RoutePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* storage full / disabled — the in-memory state still drives routing */
  }
}
