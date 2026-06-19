/**
 * EndpointInputs.tsx — stacked start/end search bars with:
 *   - Typeahead from /search
 *   - "📍 Use my location" button
 *   - "↕" swap button
 *   - Receives map-click updates via fromMapClick / toMapClick props
 */

import { useCallback } from "react";
import { SearchBar } from "./SearchBar";
import { useGeolocation } from "../hooks/useGeolocation";
import type { LngLat, SearchResult } from "../types";

interface EndpointInputsProps {
  fromLabel: string;
  toLabel: string;
  onFromChange: (lngLat: LngLat | null, name: string) => void;
  onToChange: (lngLat: LngLat | null, name: string) => void;
  onSwap: () => void;
  fromValue: string;
  toValue: string;
}

export function EndpointInputs({
  fromLabel,
  toLabel,
  onFromChange,
  onToChange,
  onSwap,
  fromValue,
  toValue,
}: EndpointInputsProps) {
  const geo = useGeolocation();

  const handleFromSelect = useCallback(
    (r: SearchResult) => onFromChange([r.lng, r.lat], r.name),
    [onFromChange]
  );
  const handleToSelect = useCallback(
    (r: SearchResult) => onToChange([r.lng, r.lat], r.name),
    [onToChange]
  );

  function handleLocateFrom() {
    geo.locate();
    // Once we have position, pass it up
    // We watch via useEffect below (or just re-call after geo updates)
  }

  // When geo.position updates, fill whichever field is currently empty (from first)
  // Simpler: expose a dedicated "locate for from" / "locate for to" pattern
  // by capturing a target via closure
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
    void handleLocateFrom; // suppress unused warning
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
