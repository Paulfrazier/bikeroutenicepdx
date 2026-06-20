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
import { arcLengthAt, haversineLength, applyManualSegments, MAX_VIAS } from "./geo";
import type { LngLat, Via, ManualSegment } from "./types";

// Monotonic id source for waypoints — gives each via a stable identity so
// re-routes never reorder or lose it.
let viaIdCounter = 0;
const nextViaId = () => `via-${++viaIdCounter}`;
let segIdCounter = 0;
const nextSegId = () => `seg-${++segIdCounter}`;
// A snapped insert landing within this many meters of an existing waypoint is
// treated as a duplicate; we keep the raw drop point so two pins never collapse.
const VIA_DEDUPE_M = 8;

export default function App() {
  // ── Endpoints ──────────────────────────────────────────────────────────────
  const [from, setFrom] = useState<LngLat | null>(null);
  const [fromLabel, setFromLabel] = useState("");
  const [to, setTo] = useState<LngLat | null>(null);
  const [toLabel, setToLabel] = useState("");

  // ── Drag-to-reshape waypoints ──────────────────────────────────────────────
  // Each drag drops (or moves) a pass-through waypoint; the route is re-fetched
  // start → vias → end. Waypoints carry a stable id + a `precise` flag and
  // PERSIST across endpoint tweaks (only an explicit reset clears them), so a
  // careful edit isn't wiped when you nudge start/end.
  const [vias, setVias] = useState<Via[]>([]);
  const [editing, setEditing] = useState(false);
  // Hand-drawn stretches spliced into the auto route (manual mode). Persist
  // across edits; cleared only on an explicit reset.
  const [manualSegments, setManualSegments] = useState<ManualSegment[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  // Leaving edit mode on an endpoint change is fine (pins persist in state and
  // reappear on re-enter); we deliberately do NOT clear `vias` here.
  useEffect(() => {
    setEditing(false);
  }, [from, to]);

  // ── Route ──────────────────────────────────────────────────────────────────
  const viaCoords = useMemo(() => vias.map((v) => v.at), [vias]);
  const { route, loading: routeLoading, error: routeError } = useRoute(
    from,
    to,
    viaCoords
  );
  const reshaped = vias.length > 0;

  // ── Bike-friendliness classification (client-side) ────────────────────────
  // Classify the active (snapped) route geometry so tiers + coverage update
  // after every reshape re-route.
  // Display geometry = the auto route with hand-drawn segments spliced in.
  const activeCoords = useMemo<LngLat[] | null>(() => {
    const auto = route?.geometry.coordinates ?? null;
    if (!auto) return null;
    return manualSegments.length
      ? applyManualSegments(auto, manualSegments)
      : auto;
  }, [route, manualSegments]);

  // Once a manual stretch is spliced, the server distance no longer matches —
  // measure the displayed geometry instead.
  const displayDistanceM = useMemo(
    () =>
      manualSegments.length && activeCoords
        ? haversineLength(activeCoords)
        : route?.distance_m ?? 0,
    [manualSegments, activeCoords, route]
  );

  // Insert a fresh waypoint along the route at arc-length position. `precise`
  // anchors are pinned exactly where dropped; normal ones snap to the nearest
  // bike-network edge (≤20m) so they land on a real path. Ordering uses
  // arc-length (monotonic) so a re-snap can't reorder existing waypoints.
  const insertViaOrdered = useCallback(
    (prev: Via[], rawAt: LngLat, precise: boolean): Via[] => {
      if (prev.length >= MAX_VIAS) return prev;
      const routeCoords = route?.geometry.coordinates ?? [];
      let at = rawAt;
      if (!precise) {
        const snapped = snapToNetwork(rawAt);
        // Don't collapse onto an existing waypoint — fall back to the raw point.
        if (snapped && !prev.some((v) => haversineLength([v.at, snapped]) < VIA_DEDUPE_M)) {
          at = snapped;
        }
      }
      const key = arcLengthAt(at, routeCoords);
      let insertAt = 0;
      for (const v of prev) {
        if (arcLengthAt(v.at, routeCoords) <= key) insertAt++;
      }
      const next = prev.slice();
      next.splice(Math.min(insertAt, next.length), 0, {
        id: nextViaId(),
        at,
        precise,
      });
      return next;
    },
    [route]
  );

  // A drag finished: move an existing waypoint (keeping its identity + kind) or
  // insert a new snapped one. A precise waypoint is never re-snapped on move.
  const handleReshape = useCallback(
    (dragged: LngLat, movingViaIndex: number | null) => {
      setVias((prev) => {
        if (movingViaIndex !== null && movingViaIndex < prev.length) {
          const moving = prev[movingViaIndex];
          const at = moving.precise ? dragged : snapToNetwork(dragged) ?? dragged;
          const next = prev.slice();
          next[movingViaIndex] = { ...moving, at };
          return next;
        }
        return insertViaOrdered(prev, dragged, false);
      });
    },
    [insertViaOrdered]
  );

  // Long-press on the bare line: drop a PRECISE anchor exactly there (no snap),
  // so the route is forced through that point (e.g. a median crossing).
  const handleInsertPrecise = useCallback(
    (at: LngLat) => {
      setVias((prev) => insertViaOrdered(prev, at, true));
    },
    [insertViaOrdered]
  );

  // Long-press on a pin: flip it between snap and precise.
  const handleToggleVia = useCallback((index: number) => {
    setVias((prev) =>
      prev.map((v, i) => (i === index ? { ...v, precise: !v.precise } : v))
    );
  }, []);

  // A waypoint pin was tapped (pressed without dragging): drop that via and
  // re-route. Endpoints stay put — only the through-waypoint is removed.
  const handleDeleteVia = useCallback((index: number) => {
    setVias((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Finished a freehand draw: keep it VERBATIM as a manual segment spliced into
  // the route (forces that stretch). Exit draw mode after one stroke.
  const handleDrawSegment = useCallback((coords: LngLat[]) => {
    if (coords.length < 2) return;
    setManualSegments((prev) => [...prev, { id: nextSegId(), coords }]);
    setDrawMode(false);
  }, []);

  // Raw-nudge a point on a manual segment (drag) — verbatim, no re-route.
  const handleManualNudge = useCallback(
    (segId: string, vertexIndex: number, at: LngLat) => {
      setManualSegments((prev) =>
        prev.map((s) =>
          s.id === segId
            ? { ...s, coords: s.coords.map((c, i) => (i === vertexIndex ? at : c)) }
            : s
        )
      );
    },
    []
  );

  // Dragged the start/end marker to fine-tune an endpoint (e.g. onto the real
  // driveway). Waypoints persist, so the route re-routes through them.
  const handleMoveEndpoint = useCallback(
    (kind: "from" | "to", lngLat: LngLat) => {
      const label = `${lngLat[1].toFixed(5)}, ${lngLat[0].toFixed(5)}`;
      if (kind === "from") {
        setFrom(lngLat);
        setFromLabel(label);
      } else {
        setTo(lngLat);
        setToLabel(label);
      }
    },
    []
  );
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
        // Explicit reset — this is the one place waypoints are cleared.
        setFrom(null);
        setFromLabel("");
        setTo(null);
        setToLabel("");
        setVias([]);
        setManualSegments([]);
        setDrawMode(false);
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
              distance_m={displayDistanceM}
              duration_s={route.duration_s}
              coverage={friendliness?.coverage}
              reshaped={reshaped || manualSegments.length > 0}
            />
            <button
              type="button"
              className={`edit-route-btn ${editing ? "edit-route-btn--active" : ""}`}
              aria-pressed={editing}
              onClick={() => setEditing((e) => !e)}
            >
              {editing ? "✓ Done editing" : "✎ Edit route"}
            </button>
            <button
              type="button"
              className={`edit-route-btn ${drawMode ? "edit-route-btn--active" : ""}`}
              aria-pressed={drawMode}
              onClick={() => setDrawMode((d) => !d)}
            >
              {drawMode ? "✓ Drawing — draw on map" : "✏️ Draw segment"}
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
          onInsertPrecise={handleInsertPrecise}
          onToggleVia={handleToggleVia}
          onMoveEndpoint={handleMoveEndpoint}
          drawMode={drawMode}
          manualSegments={manualSegments}
          onDrawSegment={handleDrawSegment}
          onManualNudge={handleManualNudge}
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
                distance_m={displayDistanceM}
                duration_s={route.duration_s}
                coverage={friendliness?.coverage}
                reshaped={reshaped || manualSegments.length > 0}
              />
              <button
                type="button"
                className={`edit-route-btn ${editing ? "edit-route-btn--active" : ""}`}
                aria-pressed={editing}
                onClick={() => setEditing((e) => !e)}
              >
                {editing ? "✓ Done editing" : "✎ Edit route"}
              </button>
              <button
                type="button"
                className={`edit-route-btn ${drawMode ? "edit-route-btn--active" : ""}`}
                aria-pressed={drawMode}
                onClick={() => setDrawMode((d) => !d)}
              >
                {drawMode ? "✓ Drawing — draw on map" : "✏️ Draw segment"}
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
