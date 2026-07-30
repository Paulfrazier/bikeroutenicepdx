/**
 * EndpointInputs.tsx — the trip's ordered address rows:
 *
 *     From              ⋯
 *      ↕      (swap, only while the trip is a plain A→B)
 *     Stop 1  … Stop N   ⋯
 *     To                ⋯
 *     + Add a stop      (only once a destination exists, under the cap)
 *
 * ONE list holds the stops AND the finish — the To row is simply the last place
 * the rider visits, not a different kind of thing. That's why a row's role is
 * editable from its ⋯ menu ("Make this the destination" / "Make this a stop")
 * rather than being fixed at the moment the place is picked.
 *
 * "+ Add a stop" is a button, not a permanently-open search box: a stop between
 * nothing and nothing is meaningless, so the affordance doesn't exist until the
 * trip has both ends. Clicking it opens ONE pending row, focused and ready to
 * type; picking a result commits it and the row closes.
 *
 * Each row is a SearchBar with typeahead from /search, saved places, and a
 * "📍 Use my location" button. Stops are pass-through places the rider is
 * actually going; the server splits the trip into legs at each one.
 */

import { useCallback, useState } from "react";
import { SearchBar } from "./SearchBar";
import { RowMenu } from "./RowMenu";
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
  /** True once the trip has a destination. Gates the "+ Add a stop" button. */
  hasDestination?: boolean;
  /** Ordered user stops between From and To. */
  stops: Via[];
  onAddStop: (result: SearchResult) => void;
  onUpdateStop: (id: string, result: SearchResult) => void;
  onRemoveStop: (id: string) => void;
  onMoveStop: (id: string, delta: number) => void;
  /** Swap a stop with the destination — see App.promoteStopToDestination. */
  onPromoteStop: (id: string) => void;
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
  hasDestination = false,
  stops,
  onAddStop,
  onUpdateStop,
  onRemoveStop,
  onMoveStop,
  onPromoteStop,
}: EndpointInputsProps) {
  /**
   * Whether the one click-summoned empty stop row is showing. Deliberately NOT
   * a placeholder entry in `vias` — a stop with no coordinate would reach the
   * router, so the row stays local until a real SearchResult commits it.
   */
  const [pendingStop, setPendingStop] = useState(false);

  const confirmClearMessage = hasRoute ? "Clear the current route?" : undefined;
  const handleFromSelect = useCallback(
    (r: SearchResult) => onFromChange([r.lng, r.lat], r.name),
    [onFromChange]
  );
  const handleToSelect = useCallback(
    (r: SearchResult) => onToChange([r.lng, r.lat], r.name),
    [onToChange]
  );
  const handlePendingSelect = useCallback(
    (r: SearchResult) => {
      onAddStop(r);
      setPendingStop(false);
    },
    [onAddStop]
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

  const atCap = stops.length >= MAX_STOPS;
  const canAddStop = hasDestination && !atCap && !pendingStop;

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

      {/* Once stops exist the ↕ button would sit mid-list and read as "swap
          these two rows" rather than "ride the whole trip backwards", so past
          that point it moves into the To row's menu. */}
      {stops.length === 0 && (
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
      )}

      {stops.length > 0 && (
        <div className="endpoint-inputs__stops">
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
              <RowMenu
                label={`Stop ${i + 1} options`}
                items={[
                  {
                    label: "Move up",
                    disabled: i === 0,
                    onSelect: () => onMoveStop(stop.id, -1),
                  },
                  {
                    label: "Move down",
                    disabled: i === stops.length - 1,
                    onSelect: () => onMoveStop(stop.id, 1),
                  },
                  {
                    label: "Make this the destination",
                    onSelect: () => onPromoteStop(stop.id),
                  },
                  {
                    label: "Remove stop",
                    destructive: true,
                    onSelect: () => onRemoveStop(stop.id),
                  },
                ]}
              />
            </div>
          ))}
        </div>
      )}

      {pendingStop && (
        <div className="endpoint-inputs__row">
          <label className="endpoint-inputs__label" htmlFor="search-add-stop">
            Stop {stops.length + 1}
          </label>
          <SearchBar
            id="search-add-stop"
            value=""
            placeholder="Search for a stop"
            onSelect={handlePendingSelect}
            onClear={() => setPendingStop(false)}
            onBlurEmpty={() => setPendingStop(false)}
            autoFocus
            aria-label={`Stop ${stops.length + 1} address`}
          />
          <button
            type="button"
            className="endpoint-inputs__cancel-btn"
            aria-label="Cancel adding a stop"
            onClick={() => setPendingStop(false)}
          >
            ✕
          </button>
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
        {stops.length > 0 ? (
          <RowMenu
            label="Destination options"
            items={[
              {
                // Swapping with the LAST stop is what "demote" means: the place
                // you were finishing at becomes the final errand instead.
                label: "Make this a stop",
                onSelect: () => onPromoteStop(stops[stops.length - 1].id),
              },
              { label: "Use my location", onSelect: () => locateFor("to") },
              { label: "Reverse the trip", onSelect: onSwap },
              {
                label: "Clear destination",
                destructive: true,
                onSelect: () => onToChange(null, ""),
              },
            ]}
          />
        ) : (
          <button
            type="button"
            className="endpoint-inputs__locate-btn"
            aria-label="Use my location for end"
            onClick={() => locateFor("to")}
          >
            📍
          </button>
        )}
      </div>

      {canAddStop && (
        <button
          type="button"
          className="endpoint-inputs__add-stop"
          onClick={() => setPendingStop(true)}
        >
          <span aria-hidden="true">＋</span> Add a stop
        </button>
      )}
      {hasDestination && atCap && (
        <p className="endpoint-inputs__cap-note">
          {MAX_STOPS} stops is the limit for one trip.
        </p>
      )}
    </div>
  );
}
