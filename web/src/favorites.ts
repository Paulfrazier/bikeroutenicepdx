/**
 * favorites.ts — the user's saved places.
 *
 * A favorite is a geocoded place the user starred so they never have to re-type it:
 * home, the kid's school, the grocery store. It wraps a `SearchResult` verbatim (the
 * same object recents persist) plus a user-editable nickname and a manual sort
 * position, so "Home" can sit at the top regardless of when it was added.
 *
 * Device-local like street ratings and connectors — nothing is ever sent to the
 * server. Favorites feed every SearchBar dropdown (above Recent) and the Favorites
 * management panel.
 *
 * Mirrors the iOS Favorites.swift store. Shares the connectors.ts store shape
 * (cache/version/subscribe) so panels re-render on change without prop drilling.
 */

import type { SearchResult } from "./types";

export interface FavoritePlace {
  id: string;
  /** User nickname. Defaults to the geocoded `place.name` when starred. */
  name: string;
  /** The geocoded place, stored verbatim so it can be used as an endpoint as-is. */
  place: SearchResult;
  /** Epoch ms when starred. */
  createdAt: number;
  /** Manual sort position, normalized to 0..n-1 on every mutation. */
  order: number;
}

const STORAGE_KEY = "bikenice.favorites";

/** Plenty for a personal list; guards a runaway import/paste from filling storage. */
export const MAX_FAVORITES = 50;

let cache: FavoritePlace[] | null = null;
let version = 0;
const listeners = new Set<() => void>();

let idCounter = 0;
function nextId(): string {
  // Time + counter; unique within a device, stable enough for a local store.
  return `fav-${Date.now().toString(36)}-${(idCounter++).toString(36)}`;
}

/** Identity of a place by position — the same dedupe key recents use. */
export function coordKey(place: { lng: number; lat: number }): string {
  return `${place.lng},${place.lat}`;
}

function isSearchResult(v: unknown): v is SearchResult {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as SearchResult).name === "string" &&
    typeof (v as SearchResult).lng === "number" &&
    typeof (v as SearchResult).lat === "number"
  );
}

function load(): FavoritePlace[] {
  if (cache) return cache;
  let parsed: FavoritePlace[] = [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown;
      if (Array.isArray(arr)) {
        parsed = arr.filter(
          (f): f is FavoritePlace =>
            !!f &&
            typeof (f as FavoritePlace).id === "string" &&
            typeof (f as FavoritePlace).name === "string" &&
            isSearchResult((f as FavoritePlace).place)
        );
      }
    }
  } catch {
    parsed = [];
  }
  // Sort defensively — a hand-edited or partially-written blob may have gaps.
  cache = normalize(parsed);
  return cache;
}

/** Sort by `order` and rewrite it to a dense 0..n-1 range. */
function normalize(list: FavoritePlace[]): FavoritePlace[] {
  return list
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt)
    .map((f, i) => (f.order === i ? f : { ...f, order: i }));
}

function persist(): void {
  cache = normalize(cache ?? []);
  version++;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full / disabled — keep the in-memory copy */
  }
  for (const cb of listeners) cb();
}

/** All favorites in the user's manual order. */
export function listFavorites(): FavoritePlace[] {
  return load();
}

export function hasFavorites(): boolean {
  return load().length > 0;
}

/** The favorite saved at this place, if any. */
export function findFavorite(place: {
  lng: number;
  lat: number;
}): FavoritePlace | undefined {
  const key = coordKey(place);
  return load().find((f) => coordKey(f.place) === key);
}

export function isFavorite(place: { lng: number; lat: number }): boolean {
  return findFavorite(place) !== undefined;
}

/**
 * Star a place. Appends to the end of the list. No-op (returns the existing entry)
 * if this exact coordinate is already saved, so double-tapping a star can't
 * duplicate. `name` defaults to the geocoded name.
 */
export function addFavorite(place: SearchResult, name?: string): FavoritePlace | null {
  const existing = findFavorite(place);
  if (existing) return existing;
  const list = load();
  if (list.length >= MAX_FAVORITES) return null;
  const fav: FavoritePlace = {
    id: nextId(),
    name: (name ?? place.name).trim() || place.name,
    place,
    createdAt: Date.now(),
    order: list.length,
  };
  cache = [...list, fav];
  persist();
  return fav;
}

export function renameFavorite(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const list = load();
  if (!list.some((f) => f.id === id)) return;
  cache = list.map((f) => (f.id === id ? { ...f, name: trimmed } : f));
  persist();
}

export function removeFavorite(id: string): void {
  const list = load();
  if (!list.some((f) => f.id === id)) return;
  cache = list.filter((f) => f.id !== id);
  persist();
}

/** Remove by place — what a star toggle in a result row needs. */
export function removeFavoriteAt(place: { lng: number; lat: number }): void {
  const existing = findFavorite(place);
  if (existing) removeFavorite(existing.id);
}

/** Star if unsaved, unstar if saved. Returns true when it ends up saved. */
export function toggleFavorite(place: SearchResult): boolean {
  const existing = findFavorite(place);
  if (existing) {
    removeFavorite(existing.id);
    return false;
  }
  return addFavorite(place) !== null;
}

/** Move a favorite to a new index in the manual order. */
export function moveFavorite(id: string, toIndex: number): void {
  const list = load();
  const from = list.findIndex((f) => f.id === id);
  if (from === -1) return;
  const clamped = Math.max(0, Math.min(toIndex, list.length - 1));
  if (clamped === from) return;
  const next = list.slice();
  const [moved] = next.splice(from, 1);
  next.splice(clamped, 0, moved);
  // Renumber so `normalize` in persist() keeps this exact order.
  cache = next.map((f, i) => ({ ...f, order: i }));
  persist();
}

/** Monotonic change counter — a stable dependency for re-rendering consumers. */
export function getVersion(): number {
  return version;
}

/** Subscribe to favorite changes. */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
