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
import { useFriendliness } from "./hooks/useFriendliness";
import { toTierFeatureCollection, snapToNetwork } from "./friendliness";
import { nearestVertexIndex, MAX_VIAS } from "./geo";
import type { LngLat } from "./types";

export default function App() {
  // ── Endpoints ──────────────────────────────────────────────────────────────
  const [from, setFrom] = useState<LngLat | null>(null);
  const [fromLabel, setFromLabel] = useState("");
  const [to, setTo] = useState<LngLat | null>(null);
  const [toLabel, setToLabel] = useState("");

  // ── Drag-to-reshape via points ───────────────────────────────────────────
  // Each drag drops (or moves) a pass-through waypoint; the route is re-fetched
  // start → vias → end, snapped to real roads. Cleared when endpoints change.
  const [vias, setVias] = useState<LngLat[]>([]);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    setVias([]);
    setEditing(false);
  }, [from, to]);

  // ── Route ──────────────────────────────────────────────────────────────────
  const { route, loading: routeLoading, error: routeError } = useRoute(
    from,
    to,
    vias
  );
  const reshaped = vias.length > 0;

  // ── Bike-friendliness classification (client-side) ────────────────────────
  // Classify the active (snapped) route geometry so tiers + coverage update
  // after every reshape re-route.
  const activeCoords = useMemo<LngLat[] | null>(
    () => route?.geometry.coordinates ?? null,
    [route]
  );

  // A drag finished: update the via list (move an existing one or insert a new
  // one in along-route order) and let useRoute re-route + snap. The dragged point
  // is first snapped to the nearest bike-network edge so the via lands on a real
  // path (not mid-block), which keeps the re-route from taking weird detours.
  const handleReshape = useCallback(
    (dragged: LngLat, movingViaIndex: number | null) => {
      const snapped = snapToNetwork(dragged) ?? dragged;
      const routeCoords = route?.geometry.coordinates ?? [];
      setVias((prev) => {
        if (movingViaIndex !== null && movingViaIndex < prev.length) {
          const next = prev.slice();
          next[movingViaIndex] = snapped;
          return next;
        }
        // Cap inserts so the route stays uncluttered (the Map also gates new
        // drags at this cap; this is a defensive backstop).
        if (prev.length >= MAX_VIAS) return prev;
        // Insert in along-route order: count existing vias that come before the
        // dragged point along the current route geometry (mirrors iOS reshape).
        const draggedKey = nearestVertexIndex(snapped, routeCoords);
        let insertAt = 0;
        for (const v of prev) {
          if (nearestVertexIndex(v, routeCoords) <= draggedKey) insertAt++;
        }
        const next = prev.slice();
        next.splice(Math.min(insertAt, next.length), 0, snapped);
        return next;
      });
    },
    [route]
  );

  // A waypoint pin was tapped (pressed without dragging): drop that via and
  // re-route. Endpoints stay put — only the through-waypoint is removed.
  const handleDeleteVia = useCallback((index: number) => {
    setVias((prev) => prev.filter((_, i) => i !== index));
  }, []);
  const friendliness = useFriendliness(activeCoords);
  const tierFeatures = useMemo(
    () =>
      activeCoords && friendliness
        ? toTierFeatureCollection(activeCoords, friendliness.tiers)
        : ({ type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection),
    [activeCoords, friendliness]
  );

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
              coverage={friendliness?.coverage}
              reshaped={reshaped}
            />
            <button
              type="button"
              className={`edit-route-btn ${editing ? "edit-route-btn--active" : ""}`}
              aria-pressed={editing}
              onClick={() => setEditing((e) => !e)}
            >
              {editing ? "✓ Done editing" : "✎ Edit route"}
            </button>
            <DirectionsPanel steps={route.steps} onStepClick={handleStepClick} />
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
          tierFeatures={tierFeatures}
          onMapClick={handleMapClick}
          onStepFlyTo={flyTo}
          editing={editing}
          vias={vias}
          onReshape={handleReshape}
          onDeleteVia={handleDeleteVia}
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
                coverage={friendliness?.coverage}
                reshaped={reshaped}
              />
              <button
                type="button"
                className={`edit-route-btn ${editing ? "edit-route-btn--active" : ""}`}
                aria-pressed={editing}
                onClick={() => setEditing((e) => !e)}
              >
                {editing ? "✓ Done editing" : "✎ Edit route"}
              </button>
              {drawerExpanded && (
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
