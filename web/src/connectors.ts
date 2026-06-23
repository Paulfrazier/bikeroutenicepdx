/**
 * connectors.ts — the user's personal network "connectors" (drawn map fixes).
 *
 * A connector is a short hand-drawn link that fills a gap the routing data misses
 * (a cycletrack OSM mislabels, a median/crosswalk connection, a cut-through). Unlike
 * the ephemeral per-route "manual segment", a connector is SAVED globally on this
 * device and feeds the route machinery everywhere:
 *   - rendered on the map as a "your fix" overlay,
 *   - classified as a `path` facility (counts comfortable, snapped to on drag),
 *   - auto-spliced into any route that passes near both of its ends.
 *
 * Personal connectors live here (localStorage). Validated COMMUNITY connectors ship
 * separately as the bundled `community-fixes.geojson` (loaded in friendliness.ts) —
 * both sources feed one connector index, but only personal ones are mutable here.
 *
 * Mirrors the iOS Connectors.swift store and the streetRatings.ts store shape
 * (subscribe/version so the visible route re-classifies + re-splices on change).
 */

import type { LngLat } from "./types";

export interface Connector {
  id: string;
  /** Polyline [lng,lat][] of the drawn link (verbatim, like a ManualSegment). */
  coords: LngLat[];
  /** Optional user label (e.g. "SE 16th cycletrack @ Hawthorne"). */
  name?: string;
  /** Epoch ms when created. */
  createdAt: number;
}

const STORAGE_KEY = "bikenice.connectors";

let cache: Connector[] | null = null;
let version = 0;
const listeners = new Set<() => void>();

let idCounter = 0;
function nextId(): string {
  // Time + counter; unique within a device, stable enough for a local store.
  return `conn-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

function load(): Connector[] {
  if (cache) return cache;
  let parsed: Connector[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        parsed = arr.filter(
          (c): c is Connector =>
            !!c &&
            typeof (c as Connector).id === "string" &&
            Array.isArray((c as Connector).coords) &&
            (c as Connector).coords.length >= 2
        );
      }
    }
  } catch {
    parsed = [];
  }
  cache = parsed;
  return cache;
}

function persist(): void {
  cache = cache ?? [];
  version++;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full / disabled — keep the in-memory copy */
  }
  for (const cb of listeners) cb();
}

/** All personal connectors (newest first). */
export function listConnectors(): Connector[] {
  return load()
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** True if the user has any personal connectors (drives the "personalized" marker). */
export function hasConnectors(): boolean {
  return load().length > 0;
}

/** Add a drawn connector; returns it. Needs ≥2 points. */
export function addConnector(coords: LngLat[], name?: string): Connector | null {
  if (coords.length < 2) return null;
  const c: Connector = { id: nextId(), coords, name, createdAt: Date.now() };
  cache = [...load(), c];
  persist();
  return c;
}

export function renameConnector(id: string, name: string): void {
  const list = load();
  const next = list.map((c) => (c.id === id ? { ...c, name } : c));
  cache = next;
  persist();
}

export function removeConnector(id: string): void {
  const list = load();
  if (!list.some((c) => c.id === id)) return;
  cache = list.filter((c) => c.id !== id);
  persist();
}

/** Replace a connector's coords (e.g. after reshaping a vertex). */
export function updateConnectorCoords(id: string, coords: LngLat[]): void {
  if (coords.length < 2) return;
  const list = load();
  if (!list.some((c) => c.id === id)) return;
  cache = list.map((c) => (c.id === id ? { ...c, coords } : c));
  persist();
}

/** Monotonic change counter — a stable dependency for re-classifying the route. */
export function getVersion(): number {
  return version;
}

/** Subscribe to connector changes. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
