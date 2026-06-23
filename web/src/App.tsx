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
import { RouteDrawer, type EditTool } from "./components/RouteDrawer";
import { Tour, GestureGuide, HelpButton, useFirstRunTour } from "./components/Help";
import {
  StreetRatingsButton,
  StreetRatingsPanel,
  RatingBar,
  useHasRatings,
} from "./components/StreetRatings";
import { setRating, removeRating, type StreetRating } from "./streetRatings";
import {
  ConnectorsButton,
  ConnectorsPanel,
  useConnectors,
  useConnectorsVersion,
} from "./components/Connectors";
import { addConnector } from "./connectors";
import { MapBoundary } from "./components/MapBoundary";
import { useRoute } from "./hooks/useRoute";
import { useFriendliness } from "./hooks/useFriendliness";
import { useNavigation } from "./hooks/useNavigation";
import { NavHud } from "./components/NavHud";
import {
  toRouteClassFeatureCollection,
  snapToNetwork,
  nearestStreetName,
  connectorSegmentsForRoute,
} from "./friendliness";
import { arcLengthAt, haversineLength, applyManualSegments, MAX_VIAS } from "./geo";
import { fetchCorridor } from "./api";
import type { LngLat, Via, ManualSegment, CorridorResponse } from "./types";

// Monotonic id source for waypoints — gives each via a stable identity so
// re-routes never reorder or lose it.
let viaIdCounter = 0;
const nextViaId = () => `via-${++viaIdCounter}`;
let segIdCounter = 0;
const nextSegId = () => `seg-${++segIdCounter}`;
let corridorIdCounter = 0;
const nextCorridorId = () => `corr-${++corridorIdCounter}`;
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

  // ── "Route through this section" (corridor) ────────────────────────────────
  // Tap point A then point B on a street; the server resolves the street between
  // them into an ordered chain of pass-through points (the preview). On confirm
  // those points are injected as a grouped block of `precise` vias, so the route
  // recomputes to flow through that street.
  const [corridorMode, setCorridorMode] = useState(false);
  const [corridorA, setCorridorA] = useState<LngLat | null>(null);
  const [corridorB, setCorridorB] = useState<LngLat | null>(null);
  const [corridorPreview, setCorridorPreview] = useState<CorridorResponse | null>(null);
  const [corridorLoading, setCorridorLoading] = useState(false);
  const [corridorError, setCorridorError] = useState<string | null>(null);

  const clearCorridorPick = useCallback(() => {
    setCorridorA(null);
    setCorridorB(null);
    setCorridorPreview(null);
    setCorridorLoading(false);
    setCorridorError(null);
  }, []);

  // ── Personal street ratings (rate-a-street) ────────────────────────────────
  // The ★ panel manages saved ratings; "rating mode" lets you tap a street on the
  // map to rate it. A rating is global by street name and recolors/re-scores the
  // route via the friendliness classifier.
  const [ratingsPanelOpen, setRatingsPanelOpen] = useState(false);
  const [ratingMode, setRatingMode] = useState(false);
  // null = no tap yet; { name } = last tapped street (name null = nothing there).
  const [ratingTarget, setRatingTarget] = useState<{ name: string | null } | null>(
    null
  );
  const personalized = useHasRatings();

  // ── Connectors (personal map-fixes) ─────────────────────────────────────────
  // The 🔧 panel manages saved connectors; "connector draw mode" lets you draw a
  // fix on the map (same freehand gesture as a manual segment). A saved connector
  // is global, rendered as a teal overlay, and auto-spliced into routes that pass
  // near both its ends (see activeCoords + connectorSegmentsForRoute).
  const [connectorsPanelOpen, setConnectorsPanelOpen] = useState(false);
  const [connectorDrawMode, setConnectorDrawMode] = useState(false);
  const connectors = useConnectors();
  const connectorsVersion = useConnectorsVersion();

  // ── Edit panel ─────────────────────────────────────────────────────────────
  // The three reshape tools (drag / draw / through-a-section) are grouped behind
  // one "Edit route" toggle. `editOpen` controls the mode selector's visibility;
  // the active mode is derived from the existing booleans so exactly one is on.
  const [editOpen, setEditOpen] = useState(false);
  const activeTool: EditTool = editing
    ? "drag"
    : drawMode
      ? "draw"
      : corridorMode
        ? "through"
        : null;
  // Select a reshape mode — turns exactly one on, the others off, and abandons
  // any half-finished corridor pick (mirrors handleToggleCorridorMode).
  const selectEditTool = useCallback(
    (tool: Exclude<EditTool, null>) => {
      setEditing(tool === "drag");
      setDrawMode(tool === "draw");
      setCorridorMode(tool === "through");
      setConnectorDrawMode(false);
      clearCorridorPick();
    },
    [clearCorridorPick]
  );
  // "Edit route" opens the panel and defaults to drag (preserves the old
  // one-tap-to-drag behavior); "Done editing" closes it and clears every mode.
  const toggleEditPanel = useCallback(() => {
    setEditOpen((open) => {
      if (open) {
        setEditing(false);
        setDrawMode(false);
        setCorridorMode(false);
        clearCorridorPick();
        return false;
      }
      setEditing(true);
      setDrawMode(false);
      setCorridorMode(false);
      setConnectorDrawMode(false);
      clearCorridorPick();
      return true;
    });
  }, [clearCorridorPick]);

  // Enter rating mode (from the panel's "rate on the map" CTA): close the panel,
  // abandon any reshape mode, and reset the tap target.
  const startRatingOnMap = useCallback(() => {
    setRatingsPanelOpen(false);
    setEditOpen(false);
    setEditing(false);
    setDrawMode(false);
    setCorridorMode(false);
    setConnectorDrawMode(false);
    clearCorridorPick();
    setRatingTarget(null);
    setRatingMode(true);
  }, [clearCorridorPick]);

  const stopRatingOnMap = useCallback(() => {
    setRatingMode(false);
    setRatingTarget(null);
  }, []);

  // Enter connector draw mode (from the 🔧 panel's "draw a fix" CTA): close the
  // panel, abandon every other mode, then arm the freehand draw. The next stroke
  // on the map becomes a saved connector (mirrors startRatingOnMap).
  const enterConnectorDraw = useCallback(() => {
    setConnectorsPanelOpen(false);
    setRatingsPanelOpen(false);
    setEditOpen(false);
    setEditing(false);
    setDrawMode(false);
    setCorridorMode(false);
    clearCorridorPick();
    setRatingMode(false);
    setRatingTarget(null);
    setConnectorDrawMode(true);
  }, [clearCorridorPick]);

  // Finished a connector stroke: save it globally (it's now classified as a
  // comfortable path + spliced into qualifying routes), then exit draw mode.
  const handleDrawConnector = useCallback((coords: LngLat[]) => {
    if (coords.length < 2) return;
    addConnector(coords);
    setConnectorDrawMode(false);
  }, []);

  // Apply (or clear) a rating for the currently tapped street; keep the target so
  // the new choice stays highlighted until another street is tapped.
  const handlePickRating = useCallback(
    (rating: StreetRating | null) => {
      const name = ratingTarget?.name;
      if (!name) return;
      if (rating) setRating(name, rating);
      else removeRating(name);
    },
    [ratingTarget]
  );

  // Leaving edit mode on an endpoint change is fine (pins persist in state and
  // reappear on re-enter); we deliberately do NOT clear `vias` here. An in-
  // progress corridor pick IS abandoned (its preview is anchored to the old route).
  useEffect(() => {
    setEditOpen(false);
    setEditing(false);
    setDrawMode(false);
    setCorridorMode(false);
    setConnectorDrawMode(false);
    clearCorridorPick();
  }, [from, to, clearCorridorPick]);

  // ── Route ──────────────────────────────────────────────────────────────────
  const viaCoords = useMemo(() => vias.map((v) => v.at), [vias]);
  const { route, loading: routeLoading, error: routeError } = useRoute(
    from,
    to,
    viaCoords
  );
  const reshaped = vias.length > 0;

  // ── Live turn-by-turn navigation (foreground; iOS has the native version) ──
  const nav = useNavigation();
  // While navigating, the displayed route follows nav reroutes; otherwise it's
  // the planner's route.
  const displayRoute = nav.navigating ? nav.activeRoute : route;

  // ── Bike-friendliness classification (client-side) ────────────────────────
  // Classify the active (snapped) route geometry so tiers + coverage update
  // after every reshape re-route.
  // Display geometry = the auto route with hand-drawn segments AND any qualifying
  // connectors (those whose both ends lie near the route) spliced in. Connectors
  // re-splice whenever the store version changes, so a freshly drawn/deleted fix
  // updates the line at once.
  const activeCoords = useMemo<LngLat[] | null>(() => {
    const auto = displayRoute?.geometry.coordinates ?? null;
    if (!auto) return null;
    // No splices while navigating — the nav route is authoritative.
    if (nav.navigating) return auto;
    const splices = [...manualSegments, ...connectorSegmentsForRoute(auto)];
    return splices.length ? applyManualSegments(auto, splices) : auto;
    // connectorsVersion gates re-splicing on store changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRoute, manualSegments, nav.navigating, connectorsVersion]);

  // Once anything is spliced (a hand-drawn stretch or a connector) the server
  // distance no longer matches — measure the displayed geometry instead. When no
  // splice applied, activeCoords is the server geometry verbatim (same ref).
  const displayDistanceM = useMemo(() => {
    const auto = displayRoute?.geometry.coordinates ?? null;
    return activeCoords && activeCoords !== auto
      ? haversineLength(activeCoords)
      : route?.distance_m ?? 0;
  }, [activeCoords, displayRoute, route]);

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
  // re-route. Endpoints stay put — only the through-waypoint is removed. If the
  // tapped via belongs to a corridor ("route through this section"), the whole
  // corridor group is removed at once so a section deletes as one unit.
  const handleDeleteVia = useCallback((index: number) => {
    setVias((prev) => {
      const target = prev[index];
      if (!target) return prev;
      if (target.corridorId) {
        return prev.filter((v) => v.corridorId !== target.corridorId);
      }
      return prev.filter((_, i) => i !== index);
    });
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

  // Second corridor tap: resolve the street between A and B into ordered points.
  const resolveCorridorPick = useCallback((a: LngLat, b: LngLat) => {
    setCorridorB(b);
    setCorridorLoading(true);
    setCorridorError(null);
    setCorridorPreview(null);
    fetchCorridor({ a, b })
      .then((res) => {
        setCorridorPreview(res);
        setCorridorLoading(false);
      })
      .catch((err: unknown) => {
        setCorridorError(
          err instanceof Error
            ? "Couldn't find a street between those points — tap closer together along one road."
            : String(err)
        );
        setCorridorLoading(false);
        // Drop the failed pick so the next tap starts a fresh A.
        setCorridorA(null);
        setCorridorB(null);
      });
  }, []);

  // Confirm the previewed corridor: inject its sampled points as a grouped block
  // of precise vias, ordered along the current route's direction of travel, then
  // re-route through them. The block stays contiguous (one corridorId).
  const handleConfirmCorridor = useCallback(() => {
    const preview = corridorPreview;
    if (!preview || preview.points.length < 2) return;
    setVias((prev) => {
      const routeCoords = route?.geometry.coordinates ?? [];
      // Orient so the endpoint nearer the route start comes first.
      let pts = preview.points;
      if (routeCoords.length >= 2) {
        const headArc = arcLengthAt(pts[0], routeCoords);
        const tailArc = arcLengthAt(pts[pts.length - 1], routeCoords);
        if (headArc > tailArc) pts = pts.slice().reverse();
      }
      // Downsample to the remaining via slots (keep first + last) so a long
      // corridor can't blow past MAX_VIAS.
      const slots = MAX_VIAS - prev.length;
      if (slots < 2) return prev;
      if (pts.length > slots) {
        const stride = (pts.length - 1) / (slots - 1);
        pts = Array.from({ length: slots }, (_, i) => pts[Math.round(i * stride)]);
      }
      const cid = nextCorridorId();
      const block: Via[] = pts.map((at) => ({
        id: nextViaId(),
        at,
        precise: true,
        corridorId: cid,
      }));
      // Insert the whole block at the arc-length position of its midpoint.
      const midArc = arcLengthAt(pts[Math.floor(pts.length / 2)], routeCoords);
      let insertAt = 0;
      for (const v of prev) {
        if (arcLengthAt(v.at, routeCoords) <= midArc) insertAt++;
      }
      const next = prev.slice();
      next.splice(Math.min(insertAt, next.length), 0, ...block);
      return next;
    });
    setCorridorMode(false);
    clearCorridorPick();
  }, [corridorPreview, route, clearCorridorPick]);

  const friendliness = useFriendliness(activeCoords);
  const routeFeatures = useMemo(
    () =>
      activeCoords && friendliness
        ? toRouteClassFeatureCollection(activeCoords, friendliness.classes)
        : ({ type: "FeatureCollection", features: [] } as GeoJSON.FeatureCollection),
    [activeCoords, friendliness]
  );

  // ── Map interaction ────────────────────────────────────────────────────────
  const clickCount = useRef(0);
  const handleMapClick = useCallback(
    (lngLat: LngLat) => {
      // Map taps are inert while navigating (the HUD owns the screen).
      if (nav.navigating) return;
      // Connector draw mode owns the gesture (a freehand drag); a bare tap is a
      // no-op so it can't drop an endpoint mid-draw.
      if (connectorDrawMode) return;
      // Rating mode: tap a street → resolve its name → show the rating picker.
      // Endpoints are untouched while rating.
      if (ratingMode) {
        setRatingTarget({ name: nearestStreetName(lngLat) });
        return;
      }
      // Corridor mode: tap A, then tap B → resolve the street between them.
      if (corridorMode) {
        if (!corridorA) {
          setCorridorA(lngLat);
          setCorridorB(null);
          setCorridorPreview(null);
          setCorridorError(null);
        } else {
          resolveCorridorPick(corridorA, lngLat);
        }
        return;
      }
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
        setConnectorDrawMode(false);
        clickCount.current = -1; // will be incremented to 0 below
      }
      clickCount.current += 1;
    },
    [ratingMode, corridorMode, corridorA, resolveCorridorPick, nav.navigating, connectorDrawMode]
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

  // ── Help: first-run tour + reopenable gesture guide ────────────────────────
  const [tourOpen, closeTour, replayTour] = useFirstRunTour();
  const [guideOpen, setGuideOpen] = useState(false);

  // ── Bottom drawer state ────────────────────────────────────────────────────
  const [drawerExpanded, setDrawerExpanded] = useState(false);

  const hasRoute = !!route;

  // Launch live turn-by-turn for the planned route.
  const handleStartNav = useCallback(() => {
    if (route && to) nav.start(route, to);
  }, [route, to, nav]);

  return (
    <div className={`app-layout ${nav.navigating ? "app-layout--navigating" : ""}`}>
      {/* ── Side panel (desktop) / top bar (mobile) ── */}
      {!nav.navigating && (
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
          hasRoute={hasRoute}
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
            <RouteDrawer
              distance_m={displayDistanceM}
              duration_s={route.duration_s}
              coverage={friendliness?.coverage}
              personalized={personalized}
              reshaped={reshaped || manualSegments.length > 0}
              onStartNav={handleStartNav}
              editOpen={editOpen}
              onToggleEdit={toggleEditPanel}
              activeTool={activeTool}
              onSelectTool={selectEditTool}
              steps={route.steps}
              onStepClick={handleStepClick}
              showDirections
            />
          </div>
        )}

        <footer className="side-panel__footer">
          <small>
            Route data: <a href="https://openstreetmap.org" target="_blank" rel="noopener noreferrer">OSM</a> (ODbL) ·{" "}
            <a href="https://www.portland.gov/transportation" target="_blank" rel="noopener noreferrer">PBOT</a>
          </small>
          <small>
            <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a> ·{" "}
            <a href="/terms.html" target="_blank" rel="noopener noreferrer">Terms</a> · Ride at your own risk
          </small>
        </footer>
      </aside>
      )}

      {/* ── Map ── */}
      <main className="map-area">
        <MapBoundary>
        <Map
          from={from}
          to={to}
          route={displayRoute}
          routeLoading={routeLoading}
          routeFeatures={routeFeatures}
          onMapClick={handleMapClick}
          onStepFlyTo={flyTo}
          navCamera={nav.camera}
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
          connectorDrawMode={connectorDrawMode}
          onDrawConnector={handleDrawConnector}
          connectors={connectors}
          corridorA={corridorA}
          corridorB={corridorB}
          corridorPreview={corridorPreview}
        />
        </MapBoundary>

        {nav.navigating && <NavHud nav={nav} onEnd={nav.stop} />}

        {!nav.navigating && <HelpButton onClick={() => setGuideOpen(true)} />}

        {!nav.navigating && (
          <StreetRatingsButton onClick={() => setRatingsPanelOpen(true)} />
        )}

        {!nav.navigating && (
          <ConnectorsButton onClick={() => setConnectorsPanelOpen(true)} />
        )}

        {/* ── Rate-a-street pick banner ── */}
        {!nav.navigating && ratingMode && (
          <RatingBar
            target={ratingTarget}
            onPick={handlePickRating}
            onDone={stopRatingOnMap}
          />
        )}

        {/* ── Corridor ("route through a section") pick banner ── */}
        {!nav.navigating && corridorMode && (
          <div className="corridor-bar" role="status" aria-live="polite">
            {corridorPreview ? (
              <>
                <span className="corridor-bar__msg">Route through this section?</span>
                <div className="corridor-bar__actions">
                  <button
                    type="button"
                    className="corridor-bar__btn corridor-bar__btn--primary"
                    onClick={handleConfirmCorridor}
                  >
                    Route through here
                  </button>
                  <button
                    type="button"
                    className="corridor-bar__btn"
                    onClick={clearCorridorPick}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : corridorLoading ? (
              <span className="corridor-bar__msg">Finding the street…</span>
            ) : corridorError ? (
              <span className="corridor-bar__msg corridor-bar__msg--error">
                {corridorError}
              </span>
            ) : corridorA ? (
              <span className="corridor-bar__msg">
                Now tap the <strong>end</strong> of the section
              </span>
            ) : (
              <span className="corridor-bar__msg">
                Tap the <strong>start</strong> of the section on a street
              </span>
            )}
          </div>
        )}

        {/* ── Connector draw banner ── */}
        {!nav.navigating && connectorDrawMode && (
          <div className="corridor-bar" role="status" aria-live="polite">
            <span className="corridor-bar__msg">
              Drag over the gap to draw a <strong>fix</strong> — lift to save it.
            </span>
            <div className="corridor-bar__actions">
              <button
                type="button"
                className="corridor-bar__btn"
                onClick={() => setConnectorDrawMode(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* ── Mobile bottom drawer ── */}
        {!nav.navigating && hasRoute && (
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
              <RouteDrawer
                distance_m={displayDistanceM}
                duration_s={route.duration_s}
                coverage={friendliness?.coverage}
                personalized={personalized}
                reshaped={reshaped || manualSegments.length > 0}
                onStartNav={handleStartNav}
                editOpen={editOpen}
                onToggleEdit={toggleEditPanel}
                activeTool={activeTool}
                onSelectTool={selectEditTool}
                steps={route.steps}
                onStepClick={handleStepClick}
                showDirections={drawerExpanded}
              />
            </div>
          </div>
        )}
      </main>

      {/* ── Street ratings panel ── */}
      <StreetRatingsPanel
        open={ratingsPanelOpen}
        onClose={() => setRatingsPanelOpen(false)}
        onRateOnMap={startRatingOnMap}
      />

      {/* ── Connectors ("my fixes") panel ── */}
      <ConnectorsPanel
        open={connectorsPanelOpen}
        onClose={() => setConnectorsPanelOpen(false)}
        onDrawOnMap={enterConnectorDraw}
      />

      {/* ── Help overlays ── */}
      <Tour open={tourOpen} onClose={closeTour} />
      <GestureGuide
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        onReplayTour={replayTour}
      />
    </div>
  );
}
