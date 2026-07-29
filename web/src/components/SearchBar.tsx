/**
 * SearchBar.tsx — address input with typeahead dropdown from /search.
 *
 * Props:
 *   value        — controlled display value (place name or empty string)
 *   placeholder  — input placeholder text
 *   onSelect     — called when user picks a result
 *   onClear      — called when the field is cleared
 *   id           — for aria-labelledby wiring
 */

import { useState, useRef, useEffect, useId, useMemo, Fragment } from "react";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";
import { useRecentSearches } from "../hooks/useRecentSearches";
import { useFavorites } from "../hooks/useFavorites";
import type { SearchResult } from "../types";

/**
 * One dropdown row. Favorites render their nickname and a filled star; search
 * results and recents render the geocoded name and an outline star that saves.
 */
type Row =
  | { kind: "favorite"; id: string; result: SearchResult }
  | { kind: "result"; result: SearchResult };

/** Lowercase and strip punctuation so "powells" matches "Powell's". */
function fold(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

interface SearchBarProps {
  value: string;
  placeholder: string;
  onSelect: (result: SearchResult) => void;
  onClear: () => void;
  id?: string;
  "aria-label"?: string;
  /**
   * When set, pressing the ✕ button asks for confirmation with this message
   * before clearing (e.g. so clearing an endpoint doesn't silently wipe an
   * existing route). Undefined = clear immediately.
   */
  confirmClearMessage?: string;
}

export function SearchBar({
  value,
  placeholder,
  onSelect,
  onClear,
  id,
  "aria-label": ariaLabel,
  confirmClearMessage,
}: SearchBarProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const listId = `${inputId}-list`;

  // Local draft — what the user is currently typing
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  // Sync external value changes (e.g. "Use my location" sets a name)
  useEffect(() => {
    setDraft(value);
  }, [value]);

  const { results, loading } = useDebouncedSearch(
    // Only search when the draft differs from the committed value
    value && draft === value ? "" : draft
  );
  const { recents, addRecent } = useRecentSearches();
  const { favorites, toggle, find } = useFavorites();

  // Show recents on focus when the user hasn't started a meaningful query.
  const trimmed = draft.trim();
  // True while the field is just displaying an already-committed pick, so the
  // text in the box is a label — not a query the user is typing.
  const showingCommitted = value !== "" && draft === value;
  const belowSearchThreshold = trimmed.length < 3 || showingCommitted;
  const showRecents =
    open && belowSearchThreshold && results.length === 0 && !loading && recents.length > 0;

  // Favorites are matched locally by nickname, so "Home" is reachable in one
  // keystroke without waiting on (or even reaching) the geocoder. Matching is
  // punctuation-insensitive so "powells" finds "Powell's".
  const favoriteRows = useMemo<Row[]>(() => {
    const q = fold(showingCommitted ? "" : trimmed);
    const matches = q
      ? favorites.filter(
          (f) => fold(f.name).includes(q) || fold(f.place.name).includes(q)
        )
      : favorites;
    return matches.map((f) => ({
      kind: "favorite",
      id: f.id,
      // The nickname is what the endpoint label should read, so swap it in.
      result: { ...f.place, name: f.name },
    }));
  }, [favorites, trimmed, showingCommitted]);

  // Whatever list the dropdown is currently driving keyboard nav over.
  const listItems = useMemo<Row[]>(() => {
    const rest = results.length > 0 ? results : showRecents ? recents : [];
    const favKeys = new Set(favoriteRows.map((r) => `${r.result.lng},${r.result.lat}`));
    return [
      ...favoriteRows,
      // A starred place already shown above shouldn't repeat in results/recents.
      ...rest
        .filter((r) => !favKeys.has(`${r.lng},${r.lat}`))
        .map((r): Row => ({ kind: "result", result: r })),
    ];
  }, [favoriteRows, results, showRecents, recents]);

  const showDropdown = open && (listItems.length > 0 || loading);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
    setOpen(true);
    setActiveIndex(-1);
    if (!e.target.value) onClear();
  }

  function handleSelect(row: Row) {
    setDraft(row.result.name);
    setOpen(false);
    setActiveIndex(-1);
    // Favorites are already durable — recording them as "recent" would only
    // evict genuinely recent picks from the 5-slot list.
    if (row.kind === "result") addRecent(row.result);
    onSelect(row.result);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!showDropdown) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, listItems.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      const r = listItems[activeIndex];
      if (r) handleSelect(r);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  /**
   * Section label for row `i`, or null when it continues the previous section.
   * Headers render inline inside the map so keyboard indices stay aligned with
   * `listItems` — an extra header <li> must never shift an option's index.
   */
  function headerFor(i: number): string | null {
    const row = listItems[i];
    const prev = i > 0 ? listItems[i - 1] : null;
    if (row.kind === "favorite") return i === 0 ? "Saved" : null;
    // Only the first non-favorite row opens the results/recents section.
    if (prev && prev.kind !== "favorite") return null;
    if (showRecents) return "Recent";
    // Plain search results carry no header when they're the only section.
    return prev ? "Results" : null;
  }

  // Close on outside click
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  return (
    <div className="search-bar" ref={wrapperRef}>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        className="search-bar__input"
        placeholder={placeholder}
        value={draft}
        onChange={handleInputChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        autoComplete="off"
        aria-label={ariaLabel ?? placeholder}
        aria-autocomplete="list"
        aria-controls={showDropdown ? listId : undefined}
        aria-activedescendant={
          activeIndex >= 0 ? `${listId}-item-${activeIndex}` : undefined
        }
        aria-expanded={showDropdown}
        role="combobox"
      />
      {draft && (
        <button
          type="button"
          className="search-bar__clear"
          aria-label="Clear"
          onClick={() => {
            if (confirmClearMessage && !window.confirm(confirmClearMessage)) return;
            setDraft("");
            setOpen(false);
            onClear();
            inputRef.current?.focus();
          }}
        >
          ✕
        </button>
      )}
      {loading && <span className="search-bar__spinner" aria-hidden="true" />}
      {showDropdown && (
        <ul
          ref={listRef}
          id={listId}
          className="search-bar__dropdown"
          role="listbox"
          aria-label="Search results"
        >
          {loading && results.length === 0 && (
            <li className="search-bar__dropdown-item search-bar__dropdown-item--loading">
              Searching…
            </li>
          )}
          {listItems.map((row, i) => {
            const r = row.result;
            const isFav = row.kind === "favorite";
            // A saved place can also surface as a plain search result (e.g. the
            // query didn't match its nickname), so the star reflects real saved
            // state — never just which section the row landed in.
            const saved = isFav || find(r) !== undefined;
            const header = headerFor(i);
            return (
              <Fragment key={isFav ? row.id : `${r.lng},${r.lat}`}>
                {header && (
                  <li
                    className="search-bar__dropdown-header"
                    role="presentation"
                    aria-hidden="true"
                  >
                    {header}
                  </li>
                )}
                <li
                  id={`${listId}-item-${i}`}
                  className={[
                    "search-bar__dropdown-item",
                    i === activeIndex ? "search-bar__dropdown-item--active" : "",
                    isFav ? "search-bar__dropdown-item--favorite" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={(e) => {
                    e.preventDefault(); // prevent blur before click
                    handleSelect(row);
                  }}
                >
                  <span className="search-bar__dropdown-type">
                    {isFav ? "saved" : r.type}
                  </span>
                  <span className="search-bar__dropdown-text">
                    <span className="search-bar__dropdown-name">{r.name}</span>
                    {r.context && (
                      <span className="search-bar__dropdown-context">{r.context}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    className={[
                      "search-bar__star",
                      saved ? "search-bar__star--on" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    aria-label={
                      saved ? `Remove ${r.name} from saved` : `Save ${r.name}`
                    }
                    aria-pressed={saved}
                    onMouseDown={(e) => {
                      // Don't let the row's select fire, and don't blur the input.
                      e.preventDefault();
                      e.stopPropagation();
                      toggle(r);
                    }}
                  >
                    {saved ? "★" : "☆"}
                  </button>
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
