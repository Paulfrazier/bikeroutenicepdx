import { useSyncExternalStore, useCallback } from "react";
import type { SearchResult } from "../types";

/**
 * Recent address picks, persisted to localStorage and shared across every
 * SearchBar instance. Most-recent-first, deduped by coordinate, capped small.
 */

const STORAGE_KEY = "bikenice.recentSearches";
const MAX_RECENTS = 5;

function coordKey(r: SearchResult): string {
  return `${r.lng},${r.lat}`;
}

function load(): SearchResult[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is SearchResult =>
        !!r &&
        typeof r === "object" &&
        typeof (r as SearchResult).name === "string" &&
        typeof (r as SearchResult).lng === "number" &&
        typeof (r as SearchResult).lat === "number"
    );
  } catch {
    return [];
  }
}

// Module-level store so both search bars stay in sync without prop drilling.
let recents: SearchResult[] = load();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    // Ignore quota / private-mode failures — recents are best-effort.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): SearchResult[] {
  return recents;
}

export function useRecentSearches() {
  const list = useSyncExternalStore(subscribe, getSnapshot, () => recents);

  const addRecent = useCallback((result: SearchResult) => {
    const key = coordKey(result);
    recents = [result, ...recents.filter((r) => coordKey(r) !== key)].slice(
      0,
      MAX_RECENTS
    );
    persist();
    emit();
  }, []);

  const clearRecents = useCallback(() => {
    recents = [];
    persist();
    emit();
  }, []);

  return { recents: list, addRecent, clearRecents };
}
