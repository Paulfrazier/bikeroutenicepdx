/**
 * Map.tsx — MapLibre GL map with:
 *   - Basemap: OpenFreeMap hosted vector style by default (free, no API key);
 *     override via VITE_BASEMAP_URL (a .pmtiles path for self-hosting, or any
 *     MapLibre style URL)
 *   - Bike network overlay: /bike-network.geojson (full Portland bike network,
 *     colored by facility class: greenway/protected/buffered/lane/path/shared)
 *   - Route line: live GeoJSON from useRoute (bold blue)
 *   - Start/end markers (green/red) placed on tap
 *   - User location dot via GeolocateControl
 *   - Legend card (bottom-left) showing facility class colors
 *
 * Basemap selection (VITE_BASEMAP_URL):
 *   - unset (default) → OpenFreeMap Liberty, a free hosted vector basemap with
 *     no API key or usage limits. Works in dev and production with zero setup.
 *   - "*.pmtiles" path/URL → self-hosted PMTiles (build it with
 *     `npm run build:tiles`; the file is gitignored). Detailed but you host it.
 *   - "" (empty) → MapLibre demotiles, a minimal low-detail fallback.
 */

import { useEffect, useRef, useCallback } from "react";
import maplibregl, {
  Map as MLMap,
  GeolocateControl,
  NavigationControl,
  Marker,
  LngLatLike,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LngLat, RouteResponse, Via } from "../types";
import { hitTestRoute, VERTEX_HIT_PX, MAX_VIAS, type Px } from "../geo";

// Protocol handler for PMTiles (lazy-import to keep bundle splittable)
let pmtilesProtocolAdded = false;
async function ensurePmtilesProtocol() {
  if (pmtilesProtocolAdded) return;
  const { Protocol } = await import("pmtiles");
  const protocol = new Protocol();
  maplibregl.addProtocol("pmtiles", protocol.tile);
  pmtilesProtocolAdded = true;
}

const PORTLAND_CENTER: LngLatLike = [-122.65, 45.52];
const PORTLAND_ZOOM = 12;

// Free hosted vector basemap — no API key, no signup, no usage limits.
// https://openfreemap.org
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";
const BASEMAP_URL =
  (import.meta.env.VITE_BASEMAP_URL as string | undefined) ?? OPENFREEMAP_STYLE;
const DEMOTILES_STYLE = "https://demotiles.maplibre.org/style.json";

/** Build a MapLibre style object for a PMTiles basemap. */
function pmtilesStyle(pmtilesUrl: string): maplibregl.StyleSpecification {
  return {
    version: 8,
    sources: {
      basemap: {
        type: "vector",
        url: `pmtiles://${pmtilesUrl}`,
      },
    },
    layers: [
      {
        id: "background",
        type: "background",
        paint: { "background-color": "#f8f4f0" },
      },
      {
        id: "water",
        type: "fill",
        source: "basemap",
        "source-layer": "water",
        paint: { "fill-color": "#a8d5e2" },
      },
      {
        id: "landuse",
        type: "fill",
        source: "basemap",
        "source-layer": "landuse",
        paint: {
          "fill-color": [
            "match",
            ["get", "class"],
            "park",
            "#c8e6c9",
            "residential",
            "#f3ede8",
            "#ece8e0",
          ],
        },
      },
      {
        id: "roads-minor",
        type: "line",
        source: "basemap",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["minor", "service", "track"]]],
        paint: { "line-color": "#d0ccc8", "line-width": 1 },
      },
      {
        id: "roads-major",
        type: "line",
        source: "basemap",
        "source-layer": "transportation",
        filter: ["in", ["get", "class"], ["literal", ["primary", "secondary", "tertiary"]]],
        paint: { "line-color": "#b8b3ae", "line-width": 2 },
      },
      {
        id: "roads-motorway",
        type: "line",
        source: "basemap",
        "source-layer": "transportation",
        filter: ["==", ["get", "class"], "motorway"],
        paint: { "line-color": "#f5c518", "line-width": 3 },
      },
      {
        id: "building",
        type: "fill",
        source: "basemap",
        "source-layer": "building",
        paint: { "fill-color": "#ddd8d2", "fill-outline-color": "#ccc6c0" },
      },
      {
        id: "road-labels",
        type: "symbol",
        source: "basemap",
        "source-layer": "transportation_name",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["noto_sans_regular"],
          "text-size": 11,
          "symbol-placement": "line",
        },
        paint: { "text-color": "#555", "text-halo-color": "#fff", "text-halo-width": 1 },
      },
      {
        id: "place-labels",
        type: "symbol",
        source: "basemap",
        "source-layer": "place",
        layout: {
          "text-field": ["get", "name"],
          "text-font": ["noto_sans_regular"],
          "text-size": ["interpolate", ["linear"], ["zoom"], 8, 10, 14, 14],
        },
        paint: { "text-color": "#333", "text-halo-color": "#fff", "text-halo-width": 1 },
      },
    ],
  };
}

function emptyGeojson(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** A single LineString feature from lng/lat coords (for the "route" source). */
function lineFeature(coords: LngLat[]): GeoJSON.Feature {
  return {
    type: "Feature",
    geometry: { type: "LineString", coordinates: coords },
    properties: {},
  };
}

/** Point features for each waypoint pin (the "route-waypoints" handle layer).
 * Carries `precise` so the layer can color snap (emerald) vs precise (amber). */
function waypointFeatures(vias: Via[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: vias.map((v) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: v.at },
      properties: { precise: v.precise },
    })),
  };
}

// ── Bike Network Legend ───────────────────────────────────────────────────────

const LEGEND_ITEMS = [
  { cls: "protected", color: "#6D28D9", label: "Protected Bike Lane",     dashed: false },
  { cls: "greenway",  color: "#2E9E48", label: "Neighborhood Greenway",   dashed: false },
  { cls: "path",      color: "#B45309", label: "Off-Street Path",         dashed: false },
  { cls: "buffered",  color: "#0891B2", label: "Buffered Bike Lane",      dashed: false },
  { cls: "lane",      color: "#F59E0B", label: "Bike Lane",               dashed: false },
  { cls: "shared",    color: "#9CA3AF", label: "Enhanced Shared Roadway", dashed: true  },
] as const;

// Route ribbon (friendliness tier) key — matches the route-line colors.
const ROUTE_LEGEND_ITEMS = [
  { tier: "green", color: "#16A34A", label: "Bike facility",    dashed: false },
  { tier: "amber", color: "#F59E0B", label: "Bike lane",        dashed: false },
  { tier: "calm",  color: "#64748B", label: "Quiet street",     dashed: false },
  { tier: "red",   color: "#DC2626", label: "Busy street",      dashed: true  },
] as const;

function BikeNetworkLegend() {
  return (
    <div className="bike-legend" aria-label="Bike network legend">
      <div className="bike-legend__title">Bike Network</div>
      <ul className="bike-legend__list">
        {LEGEND_ITEMS.map(({ cls, color, label, dashed }) => (
          <li key={cls} className="bike-legend__item">
            <span
              className="bike-legend__swatch"
              style={{
                background: dashed
                  ? `repeating-linear-gradient(to right, ${color} 0px, ${color} 5px, transparent 5px, transparent 8px)`
                  : color,
              }}
              aria-hidden="true"
            />
            <span className="bike-legend__label">{label}</span>
          </li>
        ))}
      </ul>
      <div className="bike-legend__title bike-legend__title--route">Your route</div>
      <ul className="bike-legend__list">
        {ROUTE_LEGEND_ITEMS.map(({ tier, color, label, dashed }) => (
          <li key={tier} className="bike-legend__item">
            <span
              className="bike-legend__swatch bike-legend__swatch--route"
              style={{
                background: dashed
                  ? `repeating-linear-gradient(to right, ${color} 0px, ${color} 5px, transparent 5px, transparent 8px)`
                  : color,
              }}
              aria-hidden="true"
            />
            <span className="bike-legend__label">{label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface MapProps {
  from: LngLat | null;
  to: LngLat | null;
  route: RouteResponse | null;
  /**
   * Route split into one LineString feature per contiguous friendliness tier
   * (properties.tier ∈ green|amber|red). Drives the colored route rendering.
   */
  tierFeatures: GeoJSON.FeatureCollection;
  onMapClick: (lngLat: LngLat) => void;
  onStepFlyTo: LngLat | null;
  /** When true, the route line is draggable; otherwise it's locked and the map
   * pans freely over it (prevents accidental moves). */
  editing: boolean;
  /** Ordered drag-to-reshape waypoints (owned by App). */
  vias: Via[];
  /** A drag finished: `dragged` is the released point; `movingViaIndex` is the
   * index of an existing via that was grabbed, or null to insert a new one. App
   * updates its via list and re-routes (snapping to real roads). */
  onReshape: (dragged: LngLat, movingViaIndex: number | null) => void;
  /** A waypoint pin was tapped (pressed without dragging): remove that via. */
  onDeleteVia: (index: number) => void;
  /** Long-press on the bare line: drop a PRECISE anchor there (no snap). */
  onInsertPrecise: (at: LngLat) => void;
  /** Long-press on a pin: flip it between snap and precise. */
  onToggleVia: (index: number) => void;
  /** Dragged the start/end marker to a new spot (e.g. the real driveway). */
  onMoveEndpoint: (kind: "from" | "to", lngLat: LngLat) => void;
}

export function Map({
  from,
  to,
  route,
  tierFeatures,
  onMapClick,
  onStepFlyTo,
  editing,
  vias,
  onReshape,
  onDeleteVia,
  onInsertPrecise,
  onToggleVia,
  onMoveEndpoint,
}: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const fromMarkerRef = useRef<Marker | null>(null);
  const toMarkerRef = useRef<Marker | null>(null);

  // ── Live-drag state (kept in refs; bypasses React for 60fps smoothness) ──
  // The coords currently displayed, so a mousedown can hit-test without React.
  const displayCoordsRef = useRef<LngLat[]>([]);
  // Working copy mutated during an active drag.
  const dragCoordsRef = useRef<LngLat[] | null>(null);
  const dragIndexRef = useRef<number>(-1);
  // Set true on drag-end so the synthetic "click" that follows doesn't drop a pin.
  const suppressClickRef = useRef(false);
  // Index of an existing via grabbed at drag-start (else null → insert new).
  const movingViaIndexRef = useRef<number | null>(null);
  // Pixel where the drag began + whether it has passed the move threshold, so a
  // tap on the line (in edit mode) doesn't insert a spurious via.
  const dragStartPxRef = useRef<Px | null>(null);
  const draggedFarRef = useRef(false);
  // Long-press support: a press held in place (no movement) for LONG_PRESS_MS
  // toggles a grabbed pin's precise flag, or drops a precise anchor on the line.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressLngLatRef = useRef<LngLat | null>(null);
  // Props that map listeners read live (identities change every render).
  const onReshapeRef = useRef(onReshape);
  const onDeleteViaRef = useRef(onDeleteVia);
  const onInsertPreciseRef = useRef(onInsertPrecise);
  const onToggleViaRef = useRef(onToggleVia);
  const onMoveEndpointRef = useRef(onMoveEndpoint);
  const editingRef = useRef(editing);
  const viasRef = useRef(vias);
  const tierFeaturesRef = useRef(tierFeatures);
  useEffect(() => {
    onReshapeRef.current = onReshape;
    onDeleteViaRef.current = onDeleteVia;
    onInsertPreciseRef.current = onInsertPrecise;
    onToggleViaRef.current = onToggleVia;
    onMoveEndpointRef.current = onMoveEndpoint;
    editingRef.current = editing;
    viasRef.current = vias;
    tierFeaturesRef.current = tierFeatures;
  });

  /** Movement (px) before a press becomes a reshape rather than a tap. */
  const DRAG_THRESHOLD_PX = 6;
  /** Hold time (ms) before a stationary press becomes a long-press. */
  const LONG_PRESS_MS = 450;

  // ── Initialize map ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let style: string | maplibregl.StyleSpecification;
    if (BASEMAP_URL && BASEMAP_URL.endsWith(".pmtiles")) {
      // Self-hosted PMTiles basemap (build via `npm run build:tiles`).
      ensurePmtilesProtocol().catch(console.error);
      style = pmtilesStyle(BASEMAP_URL);
    } else if (BASEMAP_URL) {
      // Hosted MapLibre style URL (default: OpenFreeMap — free, no API key).
      style = BASEMAP_URL;
    } else {
      // Empty override: minimal low-detail demotiles fallback.
      style = DEMOTILES_STYLE;
    }

    const map = new MLMap({
      container: containerRef.current,
      style,
      center: PORTLAND_CENTER,
      zoom: PORTLAND_ZOOM,
    });
    mapRef.current = map;

    map.addControl(new NavigationControl(), "top-right");
    map.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: true,
        showAccuracyCircle: true,
      }),
      "top-right"
    );

    map.on("load", () => {
      // ── Bike network overlay ─────────────────────────────────────────────
      // Full Portland bike network colored by facility class.
      // Two layers: shared (dashed, drawn first/bottom) + all others (solid, on top).
      // Within the solid layer, line-sort-key controls sub-ordering so higher-quality
      // facilities render above lower-quality ones at intersection points.
      map.addSource("bike-network", {
        type: "geojson",
        data: "/bike-network.geojson",
      });

      // Layer 1 — shared roadways only, dashed gray (drawn at bottom z-order)
      map.addLayer({
        id: "bike-network-shared",
        type: "line",
        source: "bike-network",
        filter: ["==", ["get", "class"], "shared"],
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": "#9CA3AF",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 2.5] as any,
          "line-dasharray": [4, 3],
          "line-opacity": 0.8,
        },
      });

      // Layer 2 — all non-shared classes, solid lines, color by class
      map.addLayer({
        id: "bike-network-solid",
        type: "line",
        source: "bike-network",
        filter: ["!=", ["get", "class"], "shared"],
        layout: {
          "line-cap": "round",
          "line-join": "round",
          // Draw order within this layer: higher number = painted on top
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-sort-key": ["match", ["get", "class"],
            "lane", 2,
            "buffered", 3,
            "path", 4,
            "greenway", 5,
            "protected", 6,
            1,
          ] as any,
        },
        paint: {
          "line-color": [
            "match",
            ["get", "class"],
            "greenway",  "#2E9E48",
            "protected", "#6D28D9",
            "buffered",  "#0891B2",
            "lane",      "#F59E0B",
            "path",      "#B45309",
            "#9CA3AF", // fallback
          ],
          // Zoom-responsive width: thicker for high-quality facilities
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            10, ["match", ["get", "class"],
              ["protected", "greenway", "path"], 1.5,
              ["lane", "buffered"], 1.2,
              1.0,
            ],
            16, ["match", ["get", "class"],
              ["protected", "greenway", "path"], 5,
              ["lane", "buffered"], 3.5,
              2.5,
            ],
          ] as any,
          "line-opacity": 0.85,
        },
      });

      // ── Route, colored by bike-friendliness tier (above the bike network) ─
      // The "route" source holds the run-split tier FeatureCollection. Two
      // layers render it: solid for green/amber, dashed for red.
      map.addSource("route", {
        type: "geojson",
        data: emptyGeojson(),
      });
      // Soft outer glow UNDER everything route-related. A wide, blurred,
      // semi-transparent dark line lifts the route off the basemap so it reads
      // as a raised ribbon regardless of what bike-network color sits beneath.
      map.addLayer({
        id: "route-glow",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#0f172a",
          "line-width": 16,
          "line-blur": 8,
          "line-opacity": 0.25,
        },
      });
      // White casing UNDER the colored runs, so the route always reads as a
      // distinct ribbon over the colored bike-network. Added above the glow but
      // below the tier lines, leaving a ~2.5px white halo each side.
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#ffffff",
          "line-width": 11,
        },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        filter: ["!=", ["get", "tier"], "red"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": [
            "match",
            ["get", "tier"],
            "green", "#16A34A",
            "amber", "#F59E0B",
            "calm", "#64748B",
            "#64748B",
          ],
          "line-width": 6,
        },
      });
      map.addLayer({
        id: "route-line-red",
        type: "line",
        source: "route",
        filter: ["==", ["get", "tier"], "red"],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#DC2626",
          "line-width": 6,
          "line-dasharray": [2, 2],
        },
      });

      // Transient solid line shown only during an active hand-drag (the tier
      // classification is async, so we draw a plain line until it catches up).
      map.addSource("route-drag", {
        type: "geojson",
        data: emptyGeojson(),
      });
      map.addLayer({
        id: "route-drag-line",
        type: "line",
        source: "route-drag",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#2563eb",
          "line-width": 6,
        },
      });

      // ── Waypoint pins (drawn above the route line) ───────────────────────
      // Emerald handles mark each user-placed waypoint (via). Drag a pin to move
      // it, drag the bare line to add one, tap a pin to delete it.
      map.addSource("route-waypoints", {
        type: "geojson",
        data: emptyGeojson(),
      });
      map.addLayer({
        id: "route-waypoints",
        type: "circle",
        source: "route-waypoints",
        // Hidden until the user enters edit mode (toggled by the `editing` effect).
        layout: { visibility: "none" },
        paint: {
          // Precise (forced, non-snapping) anchors read amber + larger; normal
          // snap waypoints stay emerald.
          "circle-radius": ["case", ["get", "precise"], 8, 7],
          "circle-color": ["case", ["get", "precise"], "#f59e0b", "#10b981"],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5,
        },
      });
    });

    // ── Drag the route line raw (no re-snap, no server call) ──────────────
    const getDisplayPixels = (): Px[] =>
      displayCoordsRef.current.map((c) => {
        const p = map.project(c as LngLatLike);
        return { x: p.x, y: p.y };
      });

    // Index of the existing via within grab range of `p`, else null. Grabbing
    // near a via moves it; grabbing anywhere else on the line inserts a new one.
    const nearestViaIndexPx = (p: Px): number | null => {
      let best = VERTEX_HIT_PX;
      let idx: number | null = null;
      viasRef.current.forEach((v, i) => {
        const pt = map.project(v.at as LngLatLike);
        const d = Math.hypot(p.x - pt.x, p.y - pt.y);
        if (d <= best) {
          best = d;
          idx = i;
        }
      });
      return idx;
    };

    const onMove = (
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent
    ) => {
      const coords = dragCoordsRef.current;
      const idx = dragIndexRef.current;
      if (!coords || idx < 0) return;
      // Ignore tiny movements so a tap on the line doesn't become a reshape.
      const start = dragStartPxRef.current;
      if (start && !draggedFarRef.current) {
        const dpx = Math.hypot(e.point.x - start.x, e.point.y - start.y);
        if (dpx < DRAG_THRESHOLD_PX) return;
        draggedFarRef.current = true;
        // Movement cancels a pending long-press — this is a drag, not a hold.
        if (longPressTimerRef.current) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
      }
      const cursor: LngLat = [e.lngLat.lng, e.lngLat.lat];
      coords[idx] = cursor;
      // Draw the live line on the transient drag source (the tier source is
      // cleared during the drag and refilled once the re-route completes).
      const dsrc = map.getSource("route-drag") as
        | maplibregl.GeoJSONSource
        | undefined;
      dsrc?.setData(lineFeature(coords));
      // Track the dragged waypoint pin under the cursor: move the grabbed via, or
      // show a provisional new pin where a fresh one will be inserted.
      const liveVias = viasRef.current.slice();
      const mv = movingViaIndexRef.current;
      if (mv !== null && mv < liveVias.length) {
        liveVias[mv] = { ...liveVias[mv], at: cursor };
      } else {
        liveVias.push({ id: "__drag__", at: cursor, precise: false });
      }
      const vsrc = map.getSource("route-waypoints") as
        | maplibregl.GeoJSONSource
        | undefined;
      vsrc?.setData(waypointFeatures(liveVias));
    };

    const onEnd = () => {
      // Released before the hold window — cancel any pending long-press.
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      map.off("mousemove", onMove);
      map.off("touchmove", onMove);
      map.off("mouseup", onEnd);
      map.off("touchend", onEnd);
      map.dragPan.enable();
      const coords = dragCoordsRef.current;
      const idx = dragIndexRef.current;
      const movingVia = movingViaIndexRef.current;
      const moved = draggedFarRef.current;
      dragCoordsRef.current = null;
      dragIndexRef.current = -1;
      dragStartPxRef.current = null;
      draggedFarRef.current = false;
      movingViaIndexRef.current = null;
      if (!coords || idx < 0) return;

      if (!moved) {
        if (movingVia !== null) {
          // Tapped an existing waypoint pin → delete it and re-route. Keep the
          // drag preview line on screen until the new route arrives (no flicker),
          // and optimistically drop the tapped pin from the handle layer.
          suppressClickRef.current = true;
          const remaining = viasRef.current.filter((_, i) => i !== movingVia);
          (
            map.getSource("route-waypoints") as
              | maplibregl.GeoJSONSource
              | undefined
          )?.setData(waypointFeatures(remaining));
          onDeleteViaRef.current(movingVia);
          return;
        }
        // A tap on the bare line — restore the route line and drop nothing.
        (
          map.getSource("route") as maplibregl.GeoJSONSource | undefined
        )?.setData(tierFeaturesRef.current);
        (
          map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
        )?.setData(emptyGeojson());
        (
          map.getSource("route-waypoints") as maplibregl.GeoJSONSource | undefined
        )?.setData(waypointFeatures(viasRef.current));
        return;
      }

      // Suppress the click that fires right after a drag-release.
      suppressClickRef.current = true;
      // Hand the released point up to App, which updates vias + re-routes
      // (snapping to roads). Keep the drag preview on screen until the new
      // snapped route's tierFeatures arrive — no snap-back flicker.
      onReshapeRef.current(coords[idx], movingVia);
    };

    // A press held in place (no movement) for LONG_PRESS_MS: toggle a grabbed
    // pin's precise flag, or drop a precise anchor on the bare line. Tears down
    // the in-progress drag without reshaping, and restores the route display
    // (a toggle doesn't change geometry, so nothing else would refill it).
    const fireLongPress = () => {
      longPressTimerRef.current = null;
      if (draggedFarRef.current) return; // became a drag — not a hold
      const mv = movingViaIndexRef.current;
      const at = pressLngLatRef.current;
      map.off("mousemove", onMove);
      map.off("touchmove", onMove);
      map.off("mouseup", onEnd);
      map.off("touchend", onEnd);
      map.dragPan.enable();
      dragCoordsRef.current = null;
      dragIndexRef.current = -1;
      dragStartPxRef.current = null;
      draggedFarRef.current = false;
      movingViaIndexRef.current = null;
      (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(
        tierFeaturesRef.current
      );
      (
        map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
      )?.setData(emptyGeojson());
      (
        map.getSource("route-waypoints") as maplibregl.GeoJSONSource | undefined
      )?.setData(waypointFeatures(viasRef.current));
      suppressClickRef.current = true;
      if (mv !== null) onToggleViaRef.current(mv);
      else if (at) onInsertPreciseRef.current(at);
    };

    const onDown = (
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent
    ) => {
      // Route is locked unless the user is in edit mode → no accidental grabs.
      if (!editingRef.current) return;
      if (displayCoordsRef.current.length < 2) return;
      const hit = hitTestRoute(
        { x: e.point.x, y: e.point.y },
        getDisplayPixels()
      );
      if (!hit) return; // not on the line — let MapLibre pan normally

      // Did the press grab an existing via? Decide before any insertion.
      const movingVia = nearestViaIndexPx({ x: e.point.x, y: e.point.y });
      // Inserting a new waypoint? Refuse once we're at the cap so the route can't
      // get cluttered — let the map pan normally instead. Moving an existing pin
      // is always allowed.
      if (movingVia === null && viasRef.current.length >= MAX_VIAS) return;

      e.preventDefault();
      map.dragPan.disable();

      movingViaIndexRef.current = movingVia;
      dragStartPxRef.current = { x: e.point.x, y: e.point.y };
      draggedFarRef.current = false;

      const coords = displayCoordsRef.current.map(
        (c) => [c[0], c[1]] as LngLat
      );
      if (hit.type === "segment") {
        // Insert a fresh vertex at the pointer and start dragging it.
        const ll = map.unproject([hit.point.x, hit.point.y]);
        coords.splice(hit.index + 1, 0, [ll.lng, ll.lat]);
        dragIndexRef.current = hit.index + 1;
      } else {
        dragIndexRef.current = hit.index;
      }
      dragCoordsRef.current = coords;

      // Hand off rendering to the transient drag source: clear the tier line
      // (its geometry is now stale) and seed the drag line at the start coords.
      (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(
        emptyGeojson()
      );
      (
        map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
      )?.setData(lineFeature(coords));

      // Arm the long-press: held in place it toggles a grabbed pin or drops a
      // precise anchor; a drag or early release cancels it (cleared above).
      pressLngLatRef.current = [e.lngLat.lng, e.lngLat.lat];
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(fireLongPress, LONG_PRESS_MS);

      map.on("mousemove", onMove);
      map.on("touchmove", onMove);
      map.on("mouseup", onEnd);
      map.on("touchend", onEnd);
    };

    map.on("mousedown", onDown);
    map.on("touchstart", onDown);

    // ── Tap to set markers ─────────────────────────────────────────────
    map.on("click", (e) => {
      if (suppressClickRef.current) {
        // This click is the tail of a route drag — swallow it.
        suppressClickRef.current = false;
        return;
      }
      onMapClickRef.current([e.lngLat.lng, e.lngLat.lat]);
    });

    return () => {
      // Make sure a drag-in-progress can't leave the map unpannable.
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      map.off("mousemove", onMove);
      map.off("touchmove", onMove);
      map.off("mouseup", onEnd);
      map.off("touchend", onEnd);
      map.dragPan.enable();
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep onMapClick stable reference in closure without re-creating the map
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  });

  // ── Colored tier route: drive the "route" source from the run-split FC ────
  // App classifies the active coords (server route OR hand-edit) and passes the
  // tier FeatureCollection here. Filling it also ends the transient drag draw.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(tierFeatures);
    (
      map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
    )?.setData(emptyGeojson());

    // Fade the bike network back while a route is displayed so the route owns
    // the foreground (its green tier is near-identical to the greenway color).
    // Restore full opacity when the route is cleared.
    const hasRoute = tierFeatures.features.length > 0;
    if (map.getLayer("bike-network-solid")) {
      map.setPaintProperty("bike-network-solid", "line-opacity", hasRoute ? 0.35 : 0.85);
    }
    if (map.getLayer("bike-network-shared")) {
      map.setPaintProperty("bike-network-shared", "line-opacity", hasRoute ? 0.3 : 0.8);
    }
  }, [tierFeatures]);

  // ── Server route: track coords + fit bounds (only for a fresh route) ──
  // The route geometry drives hit-testing for drags; the waypoint pins are
  // driven separately from `vias` below (handles mark user waypoints, not every
  // geometry vertex).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    if (route) {
      const coords = route.geometry.coordinates;
      displayCoordsRef.current = coords;
      // Fit map to route bounds ONLY for a fresh route (no vias). A reshape
      // re-route has vias set — refitting then would yank the viewport.
      if (coords.length > 1 && viasRef.current.length === 0) {
        const bounds = coords.reduce(
          (b, c) => b.extend(c as LngLatLike),
          new maplibregl.LngLatBounds(coords[0] as LngLatLike, coords[0] as LngLatLike)
        );
        map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
      }
    } else {
      displayCoordsRef.current = [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route]);

  // ── Waypoint pins: repaint the handle layer whenever the via list changes ──
  // (a reshape adds/moves a via, a tap deletes one, endpoint changes clear them).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (
      map.getSource("route-waypoints") as maplibregl.GeoJSONSource | undefined
    )?.setData(waypointFeatures(vias));
  }, [vias]);

  // ── Toggle the waypoint handles' visibility with edit mode ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (map.getLayer("route-waypoints")) {
      map.setLayoutProperty(
        "route-waypoints",
        "visibility",
        editing ? "visible" : "none"
      );
    }
  }, [editing]);

  // ── Sync from marker ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    fromMarkerRef.current?.remove();
    if (from) {
      const el = document.createElement("div");
      el.className = "map-marker map-marker--from";
      el.setAttribute("aria-label", "Start point (drag to adjust)");
      const marker = new Marker({ element: el, draggable: true })
        .setLngLat(from)
        .addTo(map);
      marker.on("dragend", () => {
        const { lng, lat } = marker.getLngLat();
        onMoveEndpointRef.current("from", [lng, lat]);
      });
      fromMarkerRef.current = marker;
    } else {
      fromMarkerRef.current = null;
    }
  }, [from]);

  // ── Sync to marker ───────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    toMarkerRef.current?.remove();
    if (to) {
      const el = document.createElement("div");
      el.className = "map-marker map-marker--to";
      el.setAttribute("aria-label", "End point (drag to adjust)");
      const marker = new Marker({ element: el, draggable: true })
        .setLngLat(to)
        .addTo(map);
      marker.on("dragend", () => {
        const { lng, lat } = marker.getLngLat();
        onMoveEndpointRef.current("to", [lng, lat]);
      });
      toMarkerRef.current = marker;
    } else {
      toMarkerRef.current = null;
    }
  }, [to]);

  // ── Fly to step location ─────────────────────────────────────────────────
  useEffect(() => {
    if (!onStepFlyTo || !mapRef.current) return;
    mapRef.current.flyTo({ center: onStepFlyTo, zoom: 17, duration: 800 });
  }, [onStepFlyTo]);

  return (
    <div className="map-wrapper">
      <div
        ref={containerRef}
        className="map-container"
        role="application"
        aria-label="Bike route map"
      />
      <BikeNetworkLegend />
    </div>
  );
}

// Re-export a stable callback builder so App can memoize clicks
export function useMapClickHandler(
  from: LngLat | null,
  to: LngLat | null,
  setFrom: (p: LngLat | null) => void,
  setTo: (p: LngLat | null) => void
): (lngLat: LngLat) => void {
  return useCallback(
    (lngLat: LngLat) => {
      if (!from) {
        setFrom(lngLat);
      } else if (!to) {
        setTo(lngLat);
      } else {
        // Third tap: reset
        setFrom(null);
        setTo(null);
      }
    },
    [from, to, setFrom, setTo]
  );
}
