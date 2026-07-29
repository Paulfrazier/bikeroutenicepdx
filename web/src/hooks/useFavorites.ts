import { useSyncExternalStore, useCallback } from "react";
import type { SearchResult } from "../types";
import {
  listFavorites,
  subscribe,
  addFavorite,
  removeFavorite,
  renameFavorite,
  moveFavorite,
  toggleFavorite,
  findFavorite,
  type FavoritePlace,
} from "../favorites";

/**
 * React binding for the favorites store. Every SearchBar and the Favorites panel
 * share one subscription, so starring a place updates all of them at once.
 *
 * The store hands back a stable array identity between mutations, so this is safe
 * to use as a `useSyncExternalStore` snapshot.
 */
export function useFavorites() {
  const favorites = useSyncExternalStore(subscribe, listFavorites, listFavorites);

  const add = useCallback(
    (place: SearchResult, name?: string) => addFavorite(place, name),
    []
  );
  const remove = useCallback((id: string) => removeFavorite(id), []);
  const rename = useCallback((id: string, name: string) => renameFavorite(id, name), []);
  const move = useCallback((id: string, toIndex: number) => moveFavorite(id, toIndex), []);
  const toggle = useCallback((place: SearchResult) => toggleFavorite(place), []);
  const find = useCallback(
    (place: { lng: number; lat: number }): FavoritePlace | undefined =>
      findFavorite(place),
    // Re-created on every change so callers re-run their lookup against fresh state.
    [favorites]
  );

  return { favorites, add, remove, rename, move, toggle, find };
}
