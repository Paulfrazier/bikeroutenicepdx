/**
 * App.tsx — root layout
 *
 * Mobile-first: inputs top, map middle, bottom drawer (summary + directions).
 * Desktop: left side-panel (inputs + summary + directions), map on right.
 *
 * State lives here and is passed down; no context needed at this scale.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { Map, useMapClickHandler } from "./components/Map";
import { EndpointInputs } from "./components/EndpointInputs";
import { RouteSummary } from "./components/RouteSummary";
import { DirectionsPanel } from "./components/DirectionsPanel";
import { useRoute } from "./hooks/useRoute";
import { haversineLength } from "./geo";
import type { LngLat } from "./types";

export default function App() {
  // ── Endpoints ──────────────────────────────────────────────────────────────
  const [from, setFrom] = useState<LngLat | null>(null);
  const [fromLabel, setFromLabel] = useState("");
  const [to, setTo] = useState<LngLat | null>(null);
  const [toLabel, setToLabel] = useState("");

  // ── Route ──────────────────────────────────────────────────────────────────
  const { route, loading: routeLoading, error: routeError } = useRoute(from, to);

  // ── Hand-edited route ────────────────────────────────────────────────────
  // When the user drags the line, edited coords override the server geometry.
  // A new server route clears any edits.
  const [editedCoords, setEditedCoords] = useState<LngLat[] | null>(null);
  useEffect(() => {
    setEditedCoords(null);
  }, [route]);
  const editedDistanceM = useMemo(
    () => (editedCoords ? haversineLength(editedCoords) : null),
    [editedCoords]
  );
  const manuallyEdited = editedCoords !== null;

  // ── Map interaction ────────────────────────────────────────────────────────
  const clickCount = useRef(0);
  const handleMapClick = useCallback(
    (lngLat: LngLat) => {
      // Cycle: first tap = from, second = to, third = reset
      const n = clickCount.current % 3;
      if (n === 0) {
        setFrom(lngLat);
        setFromLabel(`${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`);
      } else if (n === 1) {
        setTo(lngLat);
        setToLabel(`${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`);
      } else {
        setFrom(null);
        setFromLabel("");
        setTo(null);
        setToLabel("");
        clickCount.current = -1; // will be incremented to 0 below
      }
      clickCount.current += 1;
    },
    []
  );

  // Also wire the reusable handler from Map (for external use, e.g. tests)
  void useMapClickHandler; // available for external callers

  // ── Step fly-to ────────────────────────────────────────────────────────────
  const [flyTo, setFlyTo] = useState<LngLat | null>(null);
  const handleStepClick = useCallback((loc: LngLat) => {
    setFlyTo(loc);
    // Clear after a tick so repeated taps to same step still trigger the effect
    setTimeout(() => setFlyTo(null), 100);
  }, []);

  // ── Swap ───────────────────────────────────────────────────────────────────
  function handleSwap() {
    setFrom(to);
    setFromLabel(toLabel);
    setTo(from);
    setToLabel(fromLabel);
  }

  // ── Bottom drawer state ────────────────────────────────────────────────────
  const [drawerExpanded, setDrawerExpanded] = useState(false);

  const hasRoute = !!route;

  return (
    <div className="app-layout">
      {/* ── Side panel (desktop) / top bar (mobile) ── */}
      <aside className="side-panel" aria-label="Route planner">
        <header className="side-panel__header">
          <h1 className="side-panel__title">
            <span aria-hidden="true">🚲</span> PDX Greenways
          </h1>
        </header>

        <EndpointInputs
          fromLabel="Start address or place"
          toLabel="Destination address or place"
          fromValue={fromLabel}
          toValue={toLabel}
          onFromChange={(lngLat, name) => {
            setFrom(lngLat);
            setFromLabel(name);
            clickCount.current = lngLat ? 1 : 0;
          }}
          onToChange={(lngLat, name) => {
            setTo(lngLat);
            setToLabel(name);
          }}
          onSwap={handleSwap}
        />

        {routeLoading && (
          <p className="side-panel__status" role="status" aria-live="polite">
            Finding route…
          </p>
        )}
        {routeError && (
          <p className="side-panel__error" role="alert">
            {routeError}
          </p>
        )}

        {hasRoute && (
          <div className="side-panel__results">
            <RouteSummary
              distance_m={route.distance_m}
              duration_s={route.duration_s}
              greenway_coverage={route.greenway_coverage}
              editedDistanceM={editedDistanceM ?? undefined}
              manuallyEdited={manuallyEdited}
            />
            {/* Steps are stale once the line is hand-edited; hide them. */}
            {!manuallyEdited && (
              <DirectionsPanel
                steps={route.steps}
                onStepClick={handleStepClick}
              />
            )}
          </div>
        )}

        <footer className="side-panel__footer">
          <small>
            Route data: <a href="https://openstreetmap.org" target="_blank" rel="noopener noreferrer">OSM</a> (ODbL) ·{" "}
            <a href="https://www.portland.gov/transportation" target="_blank" rel="noopener noreferrer">PBOT</a>
          </small>
        </footer>
      </aside>

      {/* ── Map ── */}
      <main className="map-area">
        <Map
          from={from}
          to={to}
          route={route}
          onMapClick={handleMapClick}
          onStepFlyTo={flyTo}
          editedCoords={editedCoords}
          onRouteEdit={setEditedCoords}
        />

        {/* ── Mobile bottom drawer ── */}
        {hasRoute && (
          <div
            className={`bottom-drawer ${drawerExpanded ? "bottom-drawer--expanded" : ""}`}
            role="complementary"
            aria-label="Route details"
          >
            <button
              type="button"
              className="bottom-drawer__handle"
              aria-expanded={drawerExpanded}
              aria-controls="drawer-content"
              onClick={() => setDrawerExpanded((e) => !e)}
            >
              <span className="bottom-drawer__handle-bar" aria-hidden="true" />
              <span className="sr-only">
                {drawerExpanded ? "Collapse" : "Expand"} route details
              </span>
            </button>

            <div id="drawer-content" className="bottom-drawer__content">
              <RouteSummary
                distance_m={route.distance_m}
                duration_s={route.duration_s}
                greenway_coverage={route.greenway_coverage}
                editedDistanceM={editedDistanceM ?? undefined}
                manuallyEdited={manuallyEdited}
              />
              {drawerExpanded && !manuallyEdited && (
                <DirectionsPanel
                  steps={route.steps}
                  onStepClick={handleStepClick}
                />
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
