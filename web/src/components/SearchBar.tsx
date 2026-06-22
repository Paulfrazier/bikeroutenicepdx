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

import { useState, useRef, useEffect, useId } from "react";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";
import { useRecentSearches } from "../hooks/useRecentSearches";
import type { SearchResult } from "../types";

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

  // Show recents on focus when the user hasn't started a meaningful query.
  const trimmed = draft.trim();
  const belowSearchThreshold = trimmed.length < 3 || (value !== "" && draft === value);
  const showRecents =
    open && belowSearchThreshold && results.length === 0 && !loading && recents.length > 0;

  // Whatever list the dropdown is currently driving keyboard nav over.
  const listItems = results.length > 0 ? results : showRecents ? recents : [];
  const showDropdown = open && (listItems.length > 0 || loading);

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
    setOpen(true);
    setActiveIndex(-1);
    if (!e.target.value) onClear();
  }

  function handleSelect(result: SearchResult) {
    setDraft(result.name);
    setOpen(false);
    setActiveIndex(-1);
    addRecent(result);
    onSelect(result);
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
          {showRecents && (
            <li
              className="search-bar__dropdown-header"
              role="presentation"
              aria-hidden="true"
            >
              Recent
            </li>
          )}
          {listItems.map((r, i) => (
            <li
              key={`${r.lng},${r.lat}`}
              id={`${listId}-item-${i}`}
              className={[
                "search-bar__dropdown-item",
                i === activeIndex ? "search-bar__dropdown-item--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              role="option"
              aria-selected={i === activeIndex}
              onMouseDown={(e) => {
                e.preventDefault(); // prevent blur before click
                handleSelect(r);
              }}
            >
              <span className="search-bar__dropdown-type">{r.type}</span>
              <span className="search-bar__dropdown-text">
                <span className="search-bar__dropdown-name">{r.name}</span>
                {r.context && (
                  <span className="search-bar__dropdown-context">{r.context}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
