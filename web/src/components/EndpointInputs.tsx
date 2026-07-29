/**
 * EndpointInputs.tsx — the trip's ordered address rows:
 *
 *     From
 *      ↕      (swap)
 *     Stop 1  … Stop N   (optional, reorder / remove)
 *     + Add stop
 *     To
 *
 * Each row is a SearchBar with typeahead from /search, saved places, and a
 * "📍 Use my location" button. Stops are pass-through places the rider is
 * actually going; the server splits the trip into legs at each one.
 */

import { useCallback } from "react";
import { SearchBar } from "./SearchBar";
import { MAX_STOPS } from "../geo";
import type { LngLat, SearchResult, Via } from "../types";

interface EndpointInputsProps {
  fromLabel: string;
  toLabel: string;
  onFromChange: (lngLat: LngLat | null, name: string) => void;
  onToChange: (lngLat: LngLat | null, name: string) => void;
  onSwap: () => void;
  fromValue: string;
  toValue: string;
  /** True when a route is currently shown — clearing an endpoint will wipe it,
   *  so the ✕ button asks for confirmation first. */
  hasRoute?: boolean;
  /** Ordered user stops between From and To. */
  stops: Via[];
  onAddStop: (result: SearchResult) => void;
  onUpdateStop: (id: string, result: SearchResult) => void;
  onRemoveStop: (id: string) => void;
  onMoveStop: (id: string, delta: number) => void;
}

export function EndpointInputs({
  fromLabel,
  toLabel,
  onFromChange,
  onToChange,
  onSwap,
  fromValue,
  toValue,
  hasRoute = false,
  stops,
  onAddStop,
  onUpdateStop,
  onRemoveStop,
  onMoveStop,
}: EndpointInputsProps) {
  const confirmClearMessage = hasRoute ? "Clear the current route?" : undefined;
  const handleFromSelect = useCallback(
    (r: SearchResult) => onFromChange([r.lng, r.lat], r.name),
    [onFromChange]
  );
  const handleToSelect = useCallback(
    (r: SearchResult) => onToChange([r.lng, r.lat], r.name),
    [onToChange]
  );

  function locateFor(target: "from" | "to") {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lngLat: LngLat = [pos.coords.longitude, pos.coords.latitude];
        const label = "My location";
        if (target === "from") onFromChange(lngLat, label);
        else onToChange(lngLat, label);
      },
      (err) => {
        console.error("Geolocation error:", err.message);
      },
      { enableHighAccuracy: true, timeout: 10_000 }
    );
  }

  return (
    <div className="endpoint-inputs" role="group" aria-label="Trip endpoints">
      <div className="endpoint-inputs__row">
        <label className="endpoint-inputs__label" htmlFor="search-from">
          From
        </label>
        <SearchBar
          id="search-from"
          value={fromValue}
          placeholder={fromLabel}
          onSelect={handleFromSelect}
          onClear={() => onFromChange(null, "")}
          confirmClearMessage={confirmClearMessage}
          aria-label="Start address"
        />
        <button
          type="button"
          className="endpoint-inputs__locate-btn"
          aria-label="Use my location for start"
          onClick={() => locateFor("from")}
        >
          📍
        </button>
      </div>

      <div className="endpoint-inputs__swap-row">
        <button
          type="button"
          className="endpoint-inputs__swap-btn"
          aria-label="Swap start and end"
          onClick={onSwap}
        >
          ↕
        </button>
      </div>

      {stops.map((stop, i) => (
        <div className="endpoint-inputs__row" key={stop.id}>
          <label
            className="endpoint-inputs__label"
            htmlFor={`search-stop-${stop.id}`}
          >
            Stop {i + 1}
          </label>
          <SearchBar
            id={`search-stop-${stop.id}`}
            value={stop.label ?? ""}
            placeholder="Add a stop"
            onSelect={(r) => onUpdateStop(stop.id, r)}
            onClear={() => onRemoveStop(stop.id)}
            aria-label={`Stop ${i + 1} address`}
          />
          <div className="endpoint-inputs__stop-actions">
            <button
              type="button"
              className="endpoint-inputs__stop-btn"
              aria-label={`Move stop ${i + 1} up`}
              disabled={i === 0}
              onClick={() => onMoveStop(stop.id, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="endpoint-inputs__stop-btn"
              aria-label={`Move stop ${i + 1} down`}
              disabled={i === stops.length - 1}
              onClick={() => onMoveStop(stop.id, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="endpoint-inputs__stop-btn endpoint-inputs__stop-btn--remove"
              aria-label={`Remove stop ${i + 1}`}
              onClick={() => onRemoveStop(stop.id)}
            >
              ✕
            </button>
          </div>
        </div>
      ))}

      {stops.length < MAX_STOPS && (
        <div className="endpoint-inputs__row endpoint-inputs__row--add">
          <label className="endpoint-inputs__label" htmlFor="search-add-stop">
            Stop {stops.length + 1}
          </label>
          <SearchBar
            // Remounting on count change clears the box after each add, so the
            // row is always an empty "next stop" slot.
            key={`add-stop-${stops.length}`}
            id="search-add-stop"
            value=""
            placeholder="+ Add a stop"
            onSelect={onAddStop}
            onClear={() => {}}
            aria-label="Add a stop"
          />
        </div>
      )}

      <div className="endpoint-inputs__row">
        <label className="endpoint-inputs__label" htmlFor="search-to">
          To
        </label>
        <SearchBar
          id="search-to"
          value={toValue}
          placeholder={toLabel}
          onSelect={handleToSelect}
          onClear={() => onToChange(null, "")}
          confirmClearMessage={confirmClearMessage}
          aria-label="End address"
        />
        <button
          type="button"
          className="endpoint-inputs__locate-btn"
          aria-label="Use my location for end"
          onClick={() => locateFor("to")}
        >
          📍
        </button>
      </div>
    </div>
  );
}
