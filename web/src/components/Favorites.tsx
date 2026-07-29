/**
 * Favorites.tsx — UI for the user's saved places.
 *
 *  - <FavoritesButton>: a floating ★ button (mirrors ConnectorsButton), stacked
 *    under the 🔧 fixes FAB; shows a dot when any place is saved.
 *  - <FavoritesPanel>: a "Saved places" modal listing every favorite with
 *    rename / reorder / delete.
 *
 * Picking a saved place happens in the SearchBar dropdown, not here — this panel
 * is for curation. Persistence lives in ../favorites; this file is presentational.
 * Reactivity comes from the store via useFavorites.
 */

import { useFavorites } from "../hooks/useFavorites";
import { hasFavorites, getVersion, subscribe, type FavoritePlace } from "../favorites";
import { useSyncExternalStore, useMemo } from "react";
import "./Favorites.css";

/** True when the user has saved any place (re-renders on change). */
export function useHasFavorites(): boolean {
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  return useMemo(() => hasFavorites(), [version]);
}

/** Floating ★ button that opens the "Saved places" panel. */
export function FavoritesButton({ onClick }: { onClick: () => void }) {
  const active = useHasFavorites();
  return (
    <button
      type="button"
      className="favorites-fab"
      onClick={onClick}
      aria-label="Saved places"
      title="Saved places"
    >
      <span aria-hidden="true">★</span>
      {active && <span className="favorites-fab__dot" aria-hidden="true" />}
    </button>
  );
}

/** One favorite row: rename, reorder, delete. */
function FavoriteRow({
  favorite,
  index,
  count,
  onRename,
  onMove,
  onRemove,
}: {
  favorite: FavoritePlace;
  index: number;
  count: number;
  onRename: (id: string, name: string) => void;
  onMove: (id: string, toIndex: number) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <li className="favorites-row">
      <div className="favorites-row__top">
        <span className="favorites-row__swatch" aria-hidden="true">
          ★
        </span>
        <input
          className="favorites-row__name"
          type="text"
          // Uncontrolled + commit-on-blur so typing never fights the store.
          defaultValue={favorite.name}
          // Remount on rename-from-elsewhere so defaultValue re-seeds.
          key={favorite.name}
          placeholder="Name this place"
          aria-label="Saved place name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== favorite.name) onRename(favorite.id, v);
            else e.target.value = favorite.name;
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <p className="favorites-row__place">
        {favorite.place.name}
        {favorite.place.context && <span> · {favorite.place.context}</span>}
      </p>
      <div className="favorites-row__actions">
        <button
          type="button"
          className="favorites-btn"
          disabled={index === 0}
          aria-label={`Move ${favorite.name} up`}
          onClick={() => onMove(favorite.id, index - 1)}
        >
          ↑
        </button>
        <button
          type="button"
          className="favorites-btn"
          disabled={index === count - 1}
          aria-label={`Move ${favorite.name} down`}
          onClick={() => onMove(favorite.id, index + 1)}
        >
          ↓
        </button>
        <button
          type="button"
          className="favorites-btn favorites-btn--danger"
          onClick={() => onRemove(favorite.id)}
        >
          Remove
        </button>
      </div>
    </li>
  );
}

/** "Saved places" modal: rename, reorder, delete. */
export function FavoritesPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { favorites, rename, move, remove } = useFavorites();

  if (!open) return null;

  return (
    <div
      className="guide-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="favorites-title"
      onClick={onClose}
    >
      <div className="guide-card" onClick={(e) => e.stopPropagation()}>
        <header className="guide-card__header">
          <h2 id="favorites-title" className="guide-card__title">
            Saved places
          </h2>
          <button
            type="button"
            className="guide-card__close"
            onClick={onClose}
            aria-label="Close saved places"
          >
            ✕
          </button>
        </header>

        <div className="guide-card__body">
          <p className="favorites-intro">
            Saved places appear at the top of every address box, so a regular trip
            is a couple of taps. Give them short names — <strong>Home</strong>,{" "}
            <strong>School</strong> — and move the ones you use most to the top.
            Saved on this device only.
          </p>

          {favorites.length === 0 ? (
            <p className="favorites-empty">
              Nothing saved yet. Search for a place, then tap the ☆ on the right of
              any result to save it.
            </p>
          ) : (
            <ul className="favorites-list">
              {favorites.map((f, i) => (
                <FavoriteRow
                  key={f.id}
                  favorite={f}
                  index={i}
                  count={favorites.length}
                  onRename={rename}
                  onMove={move}
                  onRemove={remove}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
