/**
 * StreetRatings.tsx — UI for the user's personal, global per-street ratings.
 *
 *  - <StreetRatingsButton>: a floating ★ button (mirrors HelpButton) that opens
 *    the manage panel; shows a dot when any rating is set.
 *  - <StreetRatingsPanel>: a modal (mirrors GestureGuide) listing every rated
 *    street with an inline rating control + clear, and a "rate on the map" CTA.
 *  - <RatingBar>: the tap-to-rate banner (mirrors the corridor bar) shown while
 *    rating mode is active — tap a street, then pick a rating.
 *
 * All persistence + the rating→class mapping live in ../streetRatings; this file
 * is purely presentational. Reactivity comes from the store's version counter via
 * useSyncExternalStore, so any rating change re-renders the list and the route.
 */

import { useMemo, useSyncExternalStore } from "react";
import {
  ratingList,
  setRating,
  removeRating,
  getRating,
  hasRatings,
  getVersion,
  subscribe,
  STREET_RATINGS,
  RATING_LABEL,
  type StreetRating,
} from "../streetRatings";

/** Swatch per rating — matches the route color its class renders in. */
const RATING_SWATCH: Record<StreetRating, string> = {
  great: "#6D28D9", // protected
  good: "#2E9E48", // greenway
  bad: "#9CA3AF", // shared
  avoid: "#DC2626", // busy
};

/** Subscribe to the rating store's change counter (a stable snapshot). */
export function useRatingsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** True when the user has set any rating (re-renders on change). */
export function useHasRatings(): boolean {
  const version = useRatingsVersion();
  return useMemo(() => hasRatings(), [version]);
}

/** The four rating buttons + a Clear, with the current choice highlighted. */
function RatingButtons({
  current,
  onPick,
}: {
  current: StreetRating | null;
  onPick: (rating: StreetRating | null) => void;
}) {
  return (
    <div className="rating-choices" role="group" aria-label="Rate this street">
      {STREET_RATINGS.map((r) => (
        <button
          key={r}
          type="button"
          className={`rating-choice ${current === r ? "rating-choice--on" : ""}`}
          style={{ ["--swatch" as string]: RATING_SWATCH[r] }}
          aria-pressed={current === r}
          onClick={() => onPick(r)}
        >
          {RATING_LABEL[r]}
        </button>
      ))}
      <button
        type="button"
        className="rating-choice rating-choice--clear"
        disabled={!current}
        onClick={() => onPick(null)}
      >
        Clear
      </button>
    </div>
  );
}

/** Floating ★ button that opens the ratings panel. */
export function StreetRatingsButton({ onClick }: { onClick: () => void }) {
  const active = useHasRatings();
  return (
    <button
      type="button"
      className="ratings-fab"
      onClick={onClick}
      aria-label="My street ratings"
      title="My street ratings"
    >
      <span aria-hidden="true">★</span>
      {active && <span className="ratings-fab__dot" aria-hidden="true" />}
    </button>
  );
}

/** Modal listing every rated street; edit inline, remove, or rate on the map. */
export function StreetRatingsPanel({
  open,
  onClose,
  onRateOnMap,
}: {
  open: boolean;
  onClose: () => void;
  onRateOnMap: () => void;
}) {
  const version = useRatingsVersion();
  const list = useMemo(() => ratingList(), [version]);

  if (!open) return null;

  return (
    <div
      className="guide-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="ratings-title"
      onClick={onClose}
    >
      <div className="guide-card" onClick={(e) => e.stopPropagation()}>
        <header className="guide-card__header">
          <h2 id="ratings-title" className="guide-card__title">
            My street ratings
          </h2>
          <button
            type="button"
            className="guide-card__close"
            onClick={onClose}
            aria-label="Close street ratings"
          >
            ✕
          </button>
        </header>

        <div className="guide-card__body">
          <p className="ratings-intro">
            Rate a street and it applies <strong>everywhere that street appears</strong> —
            boosting or downgrading how routes through it are colored and scored.
          </p>

          {list.length === 0 ? (
            <p className="ratings-empty">
              No ratings yet. Tap <strong>Rate a street on the map</strong>, then
              tap any street to give it your own rating.
            </p>
          ) : (
            <ul className="ratings-list">
              {list.map(({ name, rating }) => (
                <li key={name} className="ratings-row">
                  <span className="ratings-row__name">{name}</span>
                  <RatingButtons
                    current={rating}
                    onPick={(r) =>
                      r ? setRating(name, r) : removeRating(name)
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="guide-card__footer">
          <button
            type="button"
            className="guide-card__replay"
            onClick={onRateOnMap}
          >
            ＋ Rate a street on the map
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * The tap-to-rate banner. `target` is null before the first tap, then the result
 * of the last tap ({ name } — name is null when no street was under the tap).
 */
export function RatingBar({
  target,
  onPick,
  onDone,
}: {
  target: { name: string | null } | null;
  onPick: (rating: StreetRating | null) => void;
  onDone: () => void;
}) {
  // Re-render on store changes so the picked rating highlights immediately.
  useRatingsVersion();
  const current = target?.name ? getRating(target.name) : null;

  return (
    <div className="corridor-bar rating-bar" role="status" aria-live="polite">
      {target === null ? (
        <span className="corridor-bar__msg">
          Tap a <strong>street</strong> to rate it
        </span>
      ) : target.name === null ? (
        <span className="corridor-bar__msg corridor-bar__msg--error">
          No street there — tap right on a street line
        </span>
      ) : (
        <div className="rating-bar__pick">
          <span className="corridor-bar__msg">
            Rate <strong>{target.name}</strong>
          </span>
          <RatingButtons current={current} onPick={onPick} />
        </div>
      )}
      <button type="button" className="corridor-bar__btn" onClick={onDone}>
        Done
      </button>
    </div>
  );
}
