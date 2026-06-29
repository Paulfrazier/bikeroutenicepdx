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

import { useEffect, useRef, useCallback, useState } from "react";
import maplibregl, {
  Map as MLMap,
  GeolocateControl,
  NavigationControl,
  Marker,
  LngLatLike,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { LngLat, RouteResponse, RouteGeometry, Via, ManualSegment } from "../types";
import { hitTestRoute, nearestVertexIndex, VERTEX_HIT_PX, MAX_VIAS, type Px } from "../geo";
import {
  ROUTE_CLASS_COLORS,
  ROUTE_CLASS_DASHED,
  NETWORK_LANE_GROUPS,
  presetToHidden,
  hiddenToPreset,
} from "../friendliness";
import type { RouteClass, LaneGroupKey, ComfortPreset } from "../friendliness";
import type { Connector } from "../connectors";

/** Teal "your fix" color — shared by the connector overlay + its legend entry. */
const CONNECTOR_COLOR = "#0d9488";

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

/** One Point per drawn-stroke vertex — the draggable handles shown in Draw mode. */
function strokeVertexFeatures(strokes: ManualSegment[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: strokes.flatMap((s) =>
      s.coords.map((c) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: c },
        properties: {},
      }))
    ),
  };
}

/** The "pen" marker — the last vertex of the last drawn stroke (resume point). */
function penFeature(strokes: ManualSegment[]): GeoJSON.FeatureCollection {
  const last = [...strokes].reverse().find((s) => s.coords.length >= 1);
  if (!last) return { type: "FeatureCollection", features: [] };
  return {
    type: "FeatureCollection",
    features: [pointFeature(last.coords[last.coords.length - 1])],
  };
}

/** Point features for each waypoint pin (the "route-waypoints" handle layer).
 * Carries `precise` (snap=emerald vs precise=amber) and `corridor` (a "route
 * through a section" point, drawn teal) so the layer can color them apart. */
function waypointFeatures(vias: Via[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: vias.map((v) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: v.at },
      properties: { precise: v.precise, corridor: !!v.corridorId },
    })),
  };
}

/** One LineString per saved connector, for the teal "your fix" overlay. */
function connectorFeatures(connectors: Connector[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: connectors
      .filter((c) => c.coords.length >= 2)
      .map((c) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: c.coords },
        properties: { id: c.id },
      })),
  };
}

/** A single Point feature (for the corridor A/B endpoint markers). */
function pointFeature(at: LngLat): GeoJSON.Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: at },
    properties: {},
  };
}

// ── Bike Network Legend ───────────────────────────────────────────────────────

// One unified key for BOTH the bike-network overlay and your route — the route
// is drawn in these same colors (with a white outline). Colors come from the
// shared ROUTE_CLASS_COLORS map so the route and overlay can never drift apart.
// The last two rows are route-only states (off any bike facility).
const LEGEND_ITEMS = [
  { cls: "protected", color: ROUTE_CLASS_COLORS.protected, label: "Protected bike lane",      dashed: false },
  { cls: "greenway",  color: ROUTE_CLASS_COLORS.greenway,  label: "Neighborhood greenway",    dashed: false },
  { cls: "path",      color: ROUTE_CLASS_COLORS.path,      label: "Off-street path",          dashed: false },
  { cls: "calm",      color: ROUTE_CLASS_COLORS.calm,      label: "Quiet street (recommended)",       dashed: true  },
  { cls: "buffered",  color: ROUTE_CLASS_COLORS.buffered,  label: "Buffered bike lane",       dashed: false },
  { cls: "lane",      color: ROUTE_CLASS_COLORS.lane,      label: "Bike lane",                dashed: false },
  { cls: "caution",   color: ROUTE_CLASS_COLORS.caution,   label: "Bike lane · busy arterial",     dashed: false },
  { cls: "caution4",  color: ROUTE_CLASS_COLORS.caution4,  label: "Bike lane · 4+ lane stroad",    dashed: false },
  { cls: "calm_mod",  color: ROUTE_CLASS_COLORS.calm_mod,  label: "Shared roadway · moderate traffic", dashed: true  },
  { cls: "shared",    color: ROUTE_CLASS_COLORS.shared,    label: "Shared roadway",           dashed: true  },
  { cls: "quiet",     color: ROUTE_CLASS_COLORS.quiet,     label: "Quiet street",             dashed: false },
  { cls: "busy",      color: ROUTE_CLASS_COLORS.busy,      label: "Fast or high-stress road — use caution", dashed: true  },
  // Teal overlay drawn from saved connectors (community + your fixes).
  { cls: "connector", color: CONNECTOR_COLOR,              label: "Your fix",                 dashed: false },
] as const;

// Route line paint, derived from the shared class→color map so the route can
// never drift from the legend/overlay. `ROUTE_COLOR_EXPR` colors a feature by
// its `class`; the dashed filter splits shared+busy (drawn dashed) from the
// solid facility/quiet runs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ROUTE_COLOR_EXPR: any = [
  "match",
  ["get", "class"],
  ...Object.entries(ROUTE_CLASS_COLORS).flatMap(([cls, color]) => [cls, color]),
  ROUTE_CLASS_COLORS.quiet, // fallback
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ROUTE_DASHED_FILTER: any = ["in", ["get", "class"], ["literal", [...ROUTE_CLASS_DASHED]]];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ROUTE_SOLID_FILTER: any = ["!", ["in", ["get", "class"], ["literal", [...ROUTE_CLASS_DASHED]]]];

// ── Bike-network lane-type visibility ────────────────────────────────────────
// The user can hide whole lane-type groups (NETWORK_LANE_GROUPS) from the static
// bike-network overlay. Hidden state persists per-device; only the two network
// layers are filtered — the route line is never touched.

const HIDDEN_GROUPS_KEY = "bikenice.hiddenLaneGroups";
/** Flag: the one-time "we tidied the map" comfort-preset notice has been shown. */
const COMFORT_SEEN_KEY = "bikenice.comfortSeen";
const DASHED_SET = new Set<RouteClass>(ROUTE_CLASS_DASHED);

/** Load the persisted hidden-group set, ignoring unknown/legacy keys. */
function loadHiddenGroups(): Set<LaneGroupKey> {
  try {
    const raw = localStorage.getItem(HIDDEN_GROUPS_KEY);
    // First visit (no stored value): default to the "Medium" preset, which hides
    // the "caution" group (busy roads with little bike infrastructure). A PRESENT
    // value — including an explicit "[]" ("All") — is always honored verbatim.
    if (raw == null) return presetToHidden("medium");
    const valid = new Set(NETWORK_LANE_GROUPS.map((g) => g.key));
    return new Set(
      (JSON.parse(raw) as string[]).filter((k): k is LaneGroupKey =>
        valid.has(k as LaneGroupKey)
      )
    );
  } catch {
    return new Set();
  }
}

function saveHiddenGroups(groups: Set<LaneGroupKey>): void {
  try {
    localStorage.setItem(HIDDEN_GROUPS_KEY, JSON.stringify([...groups]));
  } catch {
    /* storage unavailable (private mode) — visibility just won't persist */
  }
}

/**
 * Split the currently-visible render classes into the two network layers'
 * `rclass` membership lists. Derived entirely from NETWORK_LANE_GROUPS, so it
 * tracks the class set automatically.
 */
function visibleClasses(hidden: Set<LaneGroupKey>): {
  dashed: RouteClass[];
  solid: RouteClass[];
} {
  const dashed: RouteClass[] = [];
  const solid: RouteClass[] = [];
  for (const group of NETWORK_LANE_GROUPS) {
    if (hidden.has(group.key)) continue;
    for (const cls of group.classes) {
      (DASHED_SET.has(cls) ? dashed : solid).push(cls);
    }
  }
  return { dashed, solid };
}

/** Apply the lane-type visibility to both bike-network layers (no-op until the
 * layers exist, so it's safe to call before the map's `load` fires). */
function applyNetworkVisibility(map: MLMap, hidden: Set<LaneGroupKey>): void {
  if (!map.getLayer("bike-network-shared") || !map.getLayer("bike-network-solid")) {
    return;
  }
  const { dashed, solid } = visibleClasses(hidden);
  map.setFilter("bike-network-shared", [
    "in",
    ["get", "rclass"],
    ["literal", dashed],
  ]);
  map.setFilter("bike-network-solid", [
    "in",
    ["get", "rclass"],
    ["literal", solid],
  ]);
}

// Per-class display metadata (color/label/dashed), keyed by class, so the
// grouped legend can pull each row's swatch + label from the same source the
// flat legend used.
const LEGEND_META = Object.fromEntries(
  LEGEND_ITEMS.map((item) => [item.cls, item])
) as Record<string, (typeof LEGEND_ITEMS)[number]>;

// Route-only legend rows: the off-network "quiet" route state and the teal
// connector "your fix" overlay. Neither is part of the toggleable network
// overlay, so they render as static rows beneath the groups.
const ROUTE_ONLY_LEGEND = ["quiet", "connector"] as const;

function LegendSwatch({ color, dashed }: { color: string; dashed: boolean }) {
  return (
    <span
      className="bike-legend__swatch"
      style={{
        background: dashed
          ? `repeating-linear-gradient(to right, ${color} 0px, ${color} 5px, transparent 5px, transparent 8px)`
          : color,
      }}
      aria-hidden="true"
    />
  );
}

function LegendRow({ cls }: { cls: string }) {
  const meta = LEGEND_META[cls];
  if (!meta) return null;
  return (
    <li className="bike-legend__item">
      <LegendSwatch color={meta.color} dashed={meta.dashed} />
      <span className="bike-legend__label">{meta.label}</span>
    </li>
  );
}

// ── Comfort Lens metadata ────────────────────────────────────────────────────
// The three presets the segmented control offers, plus the one-line summary each
// one reads as. A null active preset ("Custom") falls back to the last entry.
const PRESET_ORDER: readonly ComfortPreset[] = ["gentle", "medium", "all"];
const PRESET_LABELS: Record<ComfortPreset, string> = {
  gentle: "Gentle",
  medium: "Medium",
  all: "All",
};
const PRESET_SUMMARIES: Record<ComfortPreset, string> = {
  gentle: "Protected lanes, greenways & paths only.",
  medium: "Adds painted lanes & mostly-calm streets.",
  all: "Adds busy roads with little bike infrastructure.",
};

function BikeNetworkLegend({
  open,
  onToggle,
  activePreset,
  onSetPreset,
  hiddenGroups,
  onToggleGroup,
}: {
  open: boolean;
  onToggle: () => void;
  activePreset: ComfortPreset | null;
  onSetPreset: (preset: ComfortPreset) => void;
  hiddenGroups: Set<LaneGroupKey>;
  onToggleGroup: (key: LaneGroupKey) => void;
}) {
  // The full per-class key lives behind a disclosure, closed by default.
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const chipLabel = activePreset ? PRESET_LABELS[activePreset] : "Custom";
  const summary = activePreset
    ? PRESET_SUMMARIES[activePreset]
    : "Custom selection.";

  return (
    <div className="bike-legend" aria-label="Bike network legend">
      <button
        type="button"
        className="bike-legend__toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="bike-legend__toggle-icon" aria-hidden="true">🚲</span>
        <span className="bike-legend__toggle-label">{chipLabel}</span>
        <span className="bike-legend__chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="bike-legend__body">
          {/* Primary control: the comfort dial. */}
          <div
            className="bike-legend__seg"
            role="group"
            aria-label="Comfort level"
          >
            {PRESET_ORDER.map((preset) => (
              <button
                key={preset}
                type="button"
                className={`bike-legend__seg-btn${
                  activePreset === preset ? " bike-legend__seg-btn--on" : ""
                }`}
                aria-pressed={activePreset === preset}
                onClick={() => onSetPreset(preset)}
              >
                {PRESET_LABELS[preset]}
              </button>
            ))}
          </div>

          <p className="bike-legend__summary">{summary}</p>

          {/* Disclosure: the full per-group key + static rows + caption. */}
          <div className="bike-legend__customize">
            <button
              type="button"
              className="bike-legend__customize-toggle"
              aria-expanded={customizeOpen}
              onClick={() => setCustomizeOpen((o) => !o)}
            >
              <span className="bike-legend__chevron" aria-hidden="true">
                {customizeOpen ? "▾" : "▸"}
              </span>
              Customize layers &amp; key
            </button>
            {customizeOpen && (
              <div className="bike-legend__customize-body">
                <ul className="bike-legend__list">
                  {NETWORK_LANE_GROUPS.map((group) => {
                    const hidden = hiddenGroups.has(group.key);
                    return (
                      <li
                        key={group.key}
                        className={`bike-legend__group${hidden ? " bike-legend__group--off" : ""}`}
                      >
                        <label className="bike-legend__group-head">
                          <input
                            type="checkbox"
                            className="bike-legend__checkbox"
                            checked={!hidden}
                            onChange={() => onToggleGroup(group.key)}
                          />
                          <span className="bike-legend__group-label">{group.label}</span>
                        </label>
                        <ul className="bike-legend__sublist">
                          {group.classes.map((cls) => (
                            <LegendRow key={cls} cls={cls} />
                          ))}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
                <ul className="bike-legend__list bike-legend__list--static">
                  {ROUTE_ONLY_LEGEND.map((cls) => (
                    <LegendRow key={cls} cls={cls} />
                  ))}
                </ul>
                <p className="bike-legend__caption">
                  Uncheck a group to hide those lanes from the map. Your route
                  stays drawn in these colors with a white outline.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface MapProps {
  from: LngLat | null;
  to: LngLat | null;
  route: RouteResponse | null;
  /** True while a route is being computed — auto-collapses the bike legend. */
  routeLoading: boolean;
  /**
   * Route split into one LineString feature per contiguous facility class
   * (properties.class ∈ the bike-network classes + quiet|busy). Drives the
   * colored route rendering, matching the bike-map legend.
   */
  routeFeatures: GeoJSON.FeatureCollection;
  onMapClick: (lngLat: LngLat) => void;
  onStepFlyTo: LngLat | null;
  /** When true, the route line is draggable; otherwise it's locked and the map
   * pans freely over it (prevents accidental moves). */
  editing: boolean;
  /** Guided-draw ("Build") mode: a bare map tap appends a waypoint, a tap on a
   * waypoint pin removes it, a drag on a pin moves it. The route line stays
   * locked (bare-line drags don't insert). */
  buildMode: boolean;
  /** Build mode: a bare map tap dropped a new waypoint here (append, tap order). */
  onAddWaypoint: (at: LngLat) => void;
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
  /** Draw mode: a finger/mouse stroke on the map becomes a snapped route
   * segment. Resumable — lift and the next stroke picks up from the pen. */
  drawMode: boolean;
  /** Draw "pause": while true, a drag pans/zooms the map instead of painting a
   * stroke, so the user can reposition mid-draw and then resume. */
  drawPaused: boolean;
  /** Hand-drawn strokes that make up the drawn route (App snaps each via /match).
   * Their vertices are draggable; the last vertex is the resume "pen". */
  drawnStrokes: ManualSegment[];
  /** A freehand draw stroke finished — App snaps it and appends to the route. */
  onDrawStroke: (coords: LngLat[]) => void;
  /** Raw-nudge a vertex on a drawn stroke (drag, no re-snap). */
  onStrokeNudge: (segId: string, vertexIndex: number, at: LngLat) => void;
  /** Through ("route through a section") mode is active: waypoint pins are shown
   * and tapping a section pin deletes that section. */
  corridorMode: boolean;
  /** When true, a freehand stroke on the map becomes a saved connector (a fix).
   * Shares the manual-draw gesture; the stroke is routed to onDrawConnector. */
  connectorDrawMode: boolean;
  /** A connector freehand draw finished — its coords are saved as a fix. */
  onDrawConnector: (coords: LngLat[]) => void;
  /** Saved PERSONAL connectors, rendered as the teal "your fix" overlay
   * (community connectors load separately from /community-fixes.geojson). */
  connectors: Connector[];
  /** Corridor mode: first tapped point (start of the section), or null. */
  corridorA: LngLat | null;
  /** Corridor mode: second tapped point (end of the section), or null. */
  corridorB: LngLat | null;
  /** Corridor mode: the resolved street between A and B (highlight preview). */
  corridorPreview: { geometry: RouteGeometry } | null;
  /**
   * Live navigation chase-camera target (center + heading), bumped each GPS fix.
   * Null when not navigating. Drives easeTo with a forward pitch.
   */
  navCamera: { center: LngLat; bearing: number; version: number } | null;
}

/** Minimal HTML escape for untrusted geojson property strings in popups. */
function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!
  );
}

/**
 * "Learn more about this network" popup for a built-but-unpublished supplement
 * lane (data/pbot-supplement, merged into bike-network.geojson). Shows the
 * build_note + a source link. Reused module-level so the click handler stays lean.
 */
function showSupplementPopup(
  map: maplibregl.Map,
  lngLat: maplibregl.LngLatLike,
  props: Record<string, unknown>
): void {
  const note = escapeHtml(props.build_note);
  const url = String(props.source_url ?? "");
  const link =
    url && /^https?:\/\//.test(url)
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">PBOT project page →</a>`
      : "";
  new maplibregl.Popup({ closeButton: true, maxWidth: "280px" })
    .setLngLat(lngLat)
    .setHTML(
      `<div style="font:13px/1.4 system-ui,sans-serif">` +
        `<div style="font-weight:600;margin-bottom:4px">Recently built — not yet on PBOT's map</div>` +
        `<div style="margin-bottom:6px">${note}</div>${link}</div>`
    )
    .addTo(map);
}

export function Map({
  from,
  to,
  route,
  routeLoading,
  routeFeatures,
  onMapClick,
  onStepFlyTo,
  editing,
  buildMode,
  onAddWaypoint,
  vias,
  onReshape,
  onDeleteVia,
  onInsertPrecise,
  onToggleVia,
  onMoveEndpoint,
  drawMode,
  drawPaused,
  drawnStrokes,
  onDrawStroke,
  onStrokeNudge,
  corridorMode,
  connectorDrawMode,
  onDrawConnector,
  connectors,
  corridorA,
  corridorB,
  corridorPreview,
  navCamera,
}: MapProps) {
  // Bike-network legend: open by default; auto-collapses the moment a route
  // starts computing so it's out of the way as the line draws. Transition-only
  // (effect fires on routeLoading false→true), so a manual re-open isn't fought.
  const [legendOpen, setLegendOpen] = useState(true);
  useEffect(() => {
    if (routeLoading) setLegendOpen(false);
  }, [routeLoading]);

  // One-time "we tidied the map" notice: the overlay now defaults to Medium
  // (busy roads hidden), so first-time visitors get a dismissible banner pointing
  // them at the "All" preset. Shown once per device, then the flag is set.
  const [comfortNoticeOpen, setComfortNoticeOpen] = useState(false);
  useEffect(() => {
    try {
      if (!localStorage.getItem(COMFORT_SEEN_KEY)) {
        setComfortNoticeOpen(true);
        localStorage.setItem(COMFORT_SEEN_KEY, "1");
      }
    } catch {
      /* storage unavailable (private mode) — just skip the notice */
    }
  }, []);

  // Lane-type visibility: which NETWORK_LANE_GROUPS are hidden from the static
  // bike-network overlay (persisted per-device). The route line is never filtered.
  const [hiddenGroups, setHiddenGroups] = useState<Set<LaneGroupKey>>(loadHiddenGroups);
  const toggleGroup = useCallback((key: LaneGroupKey) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveHiddenGroups(next);
      return next;
    });
  }, []);

  // Comfort Lens: the legend's primary control is a single comfort preset
  // (Gentle/Medium/All) derived from the hiddenGroups Set — the Set stays the
  // single source of truth and the preset is just a view onto it. `activePreset`
  // is null ("Custom") when the selection matches no preset.
  const activePreset = hiddenToPreset(hiddenGroups);
  const setPreset = useCallback((p: ComfortPreset) => {
    const next = presetToHidden(p);
    saveHiddenGroups(next);
    setHiddenGroups(next);
  }, []);

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
  const onAddWaypointRef = useRef(onAddWaypoint);
  const onInsertPreciseRef = useRef(onInsertPrecise);
  const onToggleViaRef = useRef(onToggleVia);
  const onMoveEndpointRef = useRef(onMoveEndpoint);
  const onDrawStrokeRef = useRef(onDrawStroke);
  const onStrokeNudgeRef = useRef(onStrokeNudge);
  const onDrawConnectorRef = useRef(onDrawConnector);
  const editingRef = useRef(editing);
  const buildModeRef = useRef(buildMode);
  const drawModeRef = useRef(drawMode);
  const drawPausedRef = useRef(drawPaused);
  const corridorModeRef = useRef(corridorMode);
  const connectorDrawModeRef = useRef(connectorDrawMode);
  const viasRef = useRef(vias);
  const drawnStrokesRef = useRef(drawnStrokes);
  const connectorsRef = useRef(connectors);
  const routeFeaturesRef = useRef(routeFeatures);
  // Current lane-type visibility, read by the map `load` handler (which closes
  // over the first render) to apply the persisted state once layers exist.
  const hiddenGroupsRef = useRef(hiddenGroups);
  // Active stroke-vertex drag (raw nudge): which stroke + vertex is moving.
  const manualEditRef = useRef<{ segId: string; vertex: number } | null>(null);
  // Freehand-draw stroke in progress (lng/lat points).
  const drawStrokeRef = useRef<LngLat[] | null>(null);
  // Which mode armed the in-progress stroke — captured at down-time so onDrawEnd
  // routes it: a saved connector fix, or a drawn route segment.
  const drawStrokeKindRef = useRef<"segment" | "connector">("segment");
  useEffect(() => {
    onReshapeRef.current = onReshape;
    onDeleteViaRef.current = onDeleteVia;
    onAddWaypointRef.current = onAddWaypoint;
    onInsertPreciseRef.current = onInsertPrecise;
    onToggleViaRef.current = onToggleVia;
    onMoveEndpointRef.current = onMoveEndpoint;
    onDrawStrokeRef.current = onDrawStroke;
    onStrokeNudgeRef.current = onStrokeNudge;
    onDrawConnectorRef.current = onDrawConnector;
    editingRef.current = editing;
    buildModeRef.current = buildMode;
    drawModeRef.current = drawMode;
    drawPausedRef.current = drawPaused;
    corridorModeRef.current = corridorMode;
    connectorDrawModeRef.current = connectorDrawMode;
    viasRef.current = vias;
    drawnStrokesRef.current = drawnStrokes;
    connectorsRef.current = connectors;
    routeFeaturesRef.current = routeFeatures;
    hiddenGroupsRef.current = hiddenGroups;
  });

  // Re-apply lane-type visibility whenever the user toggles a group. No-ops
  // until the map's layers exist (the `load` handler applies the initial state).
  useEffect(() => {
    const map = mapRef.current;
    if (map) applyNetworkVisibility(map, hiddenGroups);
  }, [hiddenGroups]);

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
      // Full Portland bike network colored by RENDER class (rclass) — the baked
      // class that already down-rates an unprotected lane on a ≥40 mph street to
      // "busy" (red), so the static overlay matches the route line exactly.
      // Two layers: dashed (shared + busy, drawn first/bottom) + solid facilities
      // (on top). Within the solid layer, line-sort-key controls sub-ordering so
      // higher-quality facilities render above lower-quality ones at crossings.
      map.addSource("bike-network", {
        type: "geojson",
        data: "/bike-network.geojson",
      });

      // Layer 1 — dashed: shared roadways (gray), fast-street lanes (red), and the
      // no-facility calm (sage) / calm_mod (goldenrod, higher-stress) streets. Bottom.
      // Filter reuses ROUTE_CLASS_DASHED so the overlay's dashed set can never
      // drift from the route line's.
      map.addLayer({
        id: "bike-network-shared",
        type: "line",
        source: "bike-network",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filter: ["in", ["get", "rclass"], ["literal", [...ROUTE_CLASS_DASHED]]] as any,
        layout: { "line-cap": "butt", "line-join": "round" },
        paint: {
          "line-color": [
            "match",
            ["get", "rclass"],
            "busy", ROUTE_CLASS_COLORS.busy,
            "calm", ROUTE_CLASS_COLORS.calm,
            "calm_mod", ROUTE_CLASS_COLORS.calm_mod,
            ROUTE_CLASS_COLORS.shared,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ] as any,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 16, 2.5] as any,
          "line-dasharray": [4, 3],
          "line-opacity": 0.8,
        },
      });

      // Layer 2 — solid facilities (everything but the dashed set), color by rclass
      map.addLayer({
        id: "bike-network-solid",
        type: "line",
        source: "bike-network",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        filter: ["!", ["in", ["get", "rclass"], ["literal", [...ROUTE_CLASS_DASHED]]]] as any,
        layout: {
          "line-cap": "round",
          "line-join": "round",
          // Draw order within this layer: higher number = painted on top
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-sort-key": ["match", ["get", "rclass"],
            "caution", 2,
            "caution4", 2,
            "lane", 3,
            "buffered", 4,
            "path", 5,
            "greenway", 6,
            "protected", 7,
            1,
          ] as any,
        },
        paint: {
          "line-color": [
            "match",
            ["get", "rclass"],
            "greenway",  "#2E9E48",
            "protected", "#6D28D9",
            "buffered",  "#0891B2",
            "lane",      "#F59E0B",
            "caution",   "#EA580C",
            "caution4",  "#DC2626",
            "path",      "#B45309",
            "#9CA3AF", // fallback
          ],
          // Zoom-responsive width: thicker for high-quality facilities
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          "line-width": [
            "interpolate", ["linear"], ["zoom"],
            10, ["match", ["get", "rclass"],
              ["protected", "greenway", "path"], 1.5,
              ["lane", "buffered", "caution", "caution4"], 1.2,
              1.0,
            ],
            16, ["match", ["get", "rclass"],
              ["protected", "greenway", "path"], 5,
              ["lane", "buffered", "caution", "caution4"], 3.5,
              2.5,
            ],
          ] as any,
          "line-opacity": 0.85,
        },
      });

      // Apply any persisted lane-type visibility now that both network layers
      // exist (the user may have hidden groups on a previous visit).
      applyNetworkVisibility(map, hiddenGroupsRef.current);

      // ── Connectors ("your fixes") overlay ────────────────────────────────
      // Saved map-fixes drawn as a persistent teal ribbon ABOVE the network but
      // BELOW the route (the active route line stays clearly on top). Two
      // sources: community fixes (static, like bike-network) + personal fixes
      // (reactive, driven from the `connectors` prop). Each gets a soft teal glow,
      // a white casing, and a teal line — mirroring the route's glow/casing idiom
      // but thinner so the route reads as the primary line.
      map.addSource("connectors-community", {
        type: "geojson",
        data: "/community-fixes.geojson",
      });
      map.addSource("connectors-personal", {
        type: "geojson",
        data: emptyGeojson(),
      });
      for (const src of ["connectors-community", "connectors-personal"]) {
        map.addLayer({
          id: `${src}-glow`,
          type: "line",
          source: src,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: {
            "line-color": CONNECTOR_COLOR,
            "line-width": 11,
            "line-blur": 6,
            "line-opacity": 0.3,
          },
        });
        map.addLayer({
          id: `${src}-casing`,
          type: "line",
          source: src,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#ffffff", "line-width": 7 },
        });
        map.addLayer({
          id: `${src}-line`,
          type: "line",
          source: src,
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": CONNECTOR_COLOR, "line-width": 4 },
        });
      }
      // Seed personal connectors saved from a previous session (the reactive
      // effect only fires on later changes, after the style is loaded).
      (
        map.getSource("connectors-personal") as
          | maplibregl.GeoJSONSource
          | undefined
      )?.setData(connectorFeatures(connectorsRef.current));

      // ── Route, colored by bike-network facility class (above the network) ─
      // The "route" source holds the run-split class FeatureCollection, drawn in
      // the SAME colors as the overlay (one legend covers both). Two layers
      // render it: solid for facility/quiet runs, dashed for shared + busy.
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
      // below the colored lines, leaving a ~2.5px white halo each side.
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
        filter: ROUTE_SOLID_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ROUTE_COLOR_EXPR,
          "line-width": 6,
        },
      });
      map.addLayer({
        id: "route-line-dashed",
        type: "line",
        source: "route",
        filter: ROUTE_DASHED_FILTER,
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": ROUTE_COLOR_EXPR,
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

      // ── Drawn-route vertices (Draw mode) — small grab handles ────────────
      // The drawn strokes are part of the main route line; these violet dots mark
      // each vertex so the user can grab one to nudge it. Shown only in Draw mode.
      map.addSource("draw-vertices", {
        type: "geojson",
        data: emptyGeojson(),
      });
      map.addLayer({
        id: "draw-vertices",
        type: "circle",
        source: "draw-vertices",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": 4,
          "circle-color": "#8B5CF6",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 1.5,
        },
      });

      // ── Draw "pen" marker — the resume point (last drawn vertex) ──────────
      // A larger violet dot showing where the next stroke will continue from.
      map.addSource("draw-pen", {
        type: "geojson",
        data: emptyGeojson(),
      });
      map.addLayer({
        id: "draw-pen",
        type: "circle",
        source: "draw-pen",
        layout: { visibility: "none" },
        paint: {
          "circle-radius": 8,
          "circle-color": "#7c3aed",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
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
          // Corridor points (a picked "section") read teal; precise (forced,
          // non-snapping) anchors read amber + larger; snap waypoints stay emerald.
          "circle-radius": ["case", ["get", "corridor"], 6, ["get", "precise"], 8, 7],
          "circle-color": [
            "case",
            ["get", "corridor"],
            "#0d9488",
            ["get", "precise"],
            "#f59e0b",
            "#10b981",
          ],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2.5,
        },
      });

      // ── Corridor ("route through a section") preview ─────────────────────
      // Shown while the user is picking a section (tap A → tap B). A teal line
      // highlights the resolved street; circles mark the two tapped endpoints.
      // On confirm the section becomes a block of vias and these clear.
      map.addSource("corridor-preview", {
        type: "geojson",
        data: emptyGeojson(),
      });
      map.addLayer({
        id: "corridor-preview-casing",
        type: "line",
        source: "corridor-preview",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0.9 },
      });
      map.addLayer({
        id: "corridor-preview-line",
        type: "line",
        source: "corridor-preview",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#0d9488", "line-width": 5 },
      });
      map.addSource("corridor-points", {
        type: "geojson",
        data: emptyGeojson(),
      });
      map.addLayer({
        id: "corridor-points",
        type: "circle",
        source: "corridor-points",
        paint: {
          "circle-radius": 8,
          "circle-color": "#0d9488",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 3,
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
      // A manual-segment nudge shows no waypoint preview — just the moving line.
      if (manualEditRef.current) return;
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
      const manualEdit = manualEditRef.current;
      const moved = draggedFarRef.current;
      dragCoordsRef.current = null;
      dragIndexRef.current = -1;
      dragStartPxRef.current = null;
      draggedFarRef.current = false;
      movingViaIndexRef.current = null;
      manualEditRef.current = null;
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
        )?.setData(routeFeaturesRef.current);
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
      if (manualEdit) {
        // Raw-nudge a vertex on a drawn stroke — verbatim, no re-snap.
        onStrokeNudgeRef.current(manualEdit.segId, manualEdit.vertex, coords[idx]);
      } else {
        // Hand the released point up to App, which updates vias + re-routes.
        // Keep the drag preview on screen until the new routeFeatures arrive.
        onReshapeRef.current(coords[idx], movingVia);
      }
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
        routeFeaturesRef.current
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

    // ── Freehand draw (manual segment) ──────────────────────────────────
    const onDrawMove = (e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent) => {
      const stroke = drawStrokeRef.current;
      if (!stroke) return;
      stroke.push([e.lngLat.lng, e.lngLat.lat]);
      (
        map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
      )?.setData(lineFeature(stroke));
    };
    const onDrawEnd = () => {
      map.off("mousemove", onDrawMove);
      map.off("touchmove", onDrawMove);
      map.off("mouseup", onDrawEnd);
      map.off("touchend", onDrawEnd);
      map.dragPan.enable();
      const stroke = drawStrokeRef.current;
      const kind = drawStrokeKindRef.current;
      drawStrokeRef.current = null;
      (
        map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
      )?.setData(emptyGeojson());
      suppressClickRef.current = true;
      if (stroke && stroke.length >= 2) {
        // The same gesture feeds a different store, by which mode armed the stroke.
        if (kind === "connector") onDrawConnectorRef.current(stroke);
        else onDrawStrokeRef.current(stroke);
      }
    };

    // The drawn-stroke vertex within grab range of `p`, else null.
    const manualHitPx = (
      p: Px
    ): { segId: string; vertex: number } | null => {
      let best = VERTEX_HIT_PX;
      let result: { segId: string; vertex: number } | null = null;
      for (const seg of drawnStrokesRef.current) {
        seg.coords.forEach((c, vi) => {
          const pt = map.project(c as LngLatLike);
          const d = Math.hypot(p.x - pt.x, p.y - pt.y);
          if (d <= best) {
            best = d;
            result = { segId: seg.id, vertex: vi };
          }
        });
      }
      return result;
    };

    // Start capturing a freehand stroke (Draw mode → drawn route; connector mode
    // → saved fix). onDrawEnd routes it to the right store by `kind`.
    const startDrawStroke = (
      kind: "segment" | "connector",
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent
    ) => {
      e.preventDefault();
      map.dragPan.disable();
      drawStrokeKindRef.current = kind;
      drawStrokeRef.current = [[e.lngLat.lng, e.lngLat.lat]];
      (
        map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
      )?.setData(lineFeature(drawStrokeRef.current));
      map.on("mousemove", onDrawMove);
      map.on("touchmove", onDrawMove);
      map.on("mouseup", onDrawEnd);
      map.on("touchend", onDrawEnd);
    };

    // Start a raw nudge of one drawn-stroke vertex. Only that stroke is shown in
    // the drag overlay; on release App rewrites the vertex (no re-snap).
    const startVertexNudge = (
      manual: { segId: string; vertex: number },
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent
    ) => {
      const seg = drawnStrokesRef.current.find((s) => s.id === manual.segId);
      if (!seg) return;
      e.preventDefault();
      map.dragPan.disable();
      manualEditRef.current = manual;
      movingViaIndexRef.current = null;
      dragStartPxRef.current = { x: e.point.x, y: e.point.y };
      draggedFarRef.current = false;
      const coords = seg.coords.map((c) => [c[0], c[1]] as LngLat);
      dragCoordsRef.current = coords;
      dragIndexRef.current = manual.vertex;
      (
        map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
      )?.setData(lineFeature(coords));
      map.on("mousemove", onMove);
      map.on("touchmove", onMove);
      map.on("mouseup", onEnd);
      map.on("touchend", onEnd);
    };

    // Start a drag of the whole displayed line at vertex/segment `hit`, either
    // moving an existing via (`movingVia`) or inserting a fresh one.
    const beginLineDrag = (
      hit: { type: "vertex"; index: number } | { type: "segment"; index: number; point: Px },
      movingVia: number | null,
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent
    ) => {
      e.preventDefault();
      map.dragPan.disable();
      manualEditRef.current = null;
      movingViaIndexRef.current = movingVia;
      dragStartPxRef.current = { x: e.point.x, y: e.point.y };
      draggedFarRef.current = false;

      const coords = displayCoordsRef.current.map((c) => [c[0], c[1]] as LngLat);
      if (hit.type === "segment") {
        const ll = map.unproject([hit.point.x, hit.point.y]);
        coords.splice(hit.index + 1, 0, [ll.lng, ll.lat]);
        dragIndexRef.current = hit.index + 1;
      } else {
        dragIndexRef.current = hit.index;
      }
      dragCoordsRef.current = coords;

      // Hand rendering to the transient drag source: clear the (now stale) tier
      // line and seed the drag line at the start coords.
      (map.getSource("route") as maplibregl.GeoJSONSource | undefined)?.setData(
        emptyGeojson()
      );
      (
        map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
      )?.setData(lineFeature(coords));

      // Held in place, a press toggles a grabbed pin or drops a precise anchor.
      pressLngLatRef.current = [e.lngLat.lng, e.lngLat.lat];
      if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(fireLongPress, LONG_PRESS_MS);

      map.on("mousemove", onMove);
      map.on("touchmove", onMove);
      map.on("mouseup", onEnd);
      map.on("touchend", onEnd);
    };

    const onDown = (
      e: maplibregl.MapMouseEvent | maplibregl.MapTouchEvent
    ) => {
      const point: Px = { x: e.point.x, y: e.point.y };

      // Connector draw: a freehand stroke becomes a saved fix.
      if (connectorDrawModeRef.current) {
        startDrawStroke("connector", e);
        return;
      }

      // Draw mode: grab a stroke vertex to nudge it, else start a (resumable)
      // stroke — the pen continues from where the last stroke ended. While
      // paused, fall through so the press pans/zooms the map (default dragPan).
      if (drawModeRef.current && !drawPausedRef.current) {
        const manual = manualHitPx(point);
        if (manual) startVertexNudge(manual, e);
        else startDrawStroke("segment", e);
        return;
      }

      // Build mode: drag an existing waypoint pin to move it. A bare-map press is
      // left to the click handler (which appends a waypoint).
      if (buildModeRef.current) {
        const mv = nearestViaIndexPx(point);
        if (mv === null) return;
        const coords = displayCoordsRef.current;
        if (coords.length < 2) return;
        beginLineDrag({ type: "vertex", index: nearestVertexIndex(viasRef.current[mv].at, coords) }, mv, e);
        return;
      }

      // Drag (edit) mode.
      if (editingRef.current) {
        if (displayCoordsRef.current.length < 2) return;
        // A drawn route is edited only by nudging its stroke vertices.
        const manual = manualHitPx(point);
        if (manual) {
          startVertexNudge(manual, e);
          return;
        }
        if (drawnStrokesRef.current.length > 0) return;
        const hit = hitTestRoute(point, getDisplayPixels());
        if (!hit) return; // not on the line — let MapLibre pan normally
        const movingVia = nearestViaIndexPx(point);
        // Refuse a NEW via once at the cap (moving an existing pin is fine).
        if (movingVia === null && viasRef.current.length >= MAX_VIAS) return;
        beginLineDrag(hit, movingVia, e);
        return;
      }
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
      // Guided-draw ("Build") mode owns the tap: hit an existing waypoint pin →
      // remove it; tap anywhere else → append a new waypoint (tap order). The
      // App-level from/to cycle is bypassed while building.
      if (buildModeRef.current) {
        const hitVia = nearestViaIndexPx({ x: e.point.x, y: e.point.y });
        if (hitVia !== null) onDeleteViaRef.current(hitVia);
        else onAddWaypointRef.current([e.lngLat.lng, e.lngLat.lat]);
        return;
      }
      // Through mode: tapping an existing section's pin removes that section;
      // otherwise the tap falls through to App's two-tap A→B pick.
      if (corridorModeRef.current) {
        const hitVia = nearestViaIndexPx({ x: e.point.x, y: e.point.y });
        if (hitVia !== null) {
          onDeleteViaRef.current(hitVia);
          return;
        }
      }
      // Draw mode owns the gesture: drawing is a drag and panning-while-paused
      // is a drag, so a bare tap is inert — never let it drop a from/to pin.
      if (drawModeRef.current) return;
      // Tap a built-but-unpublished supplement lane → "learn more" popup instead
      // of dropping an A/B pin. Small pixel box so it's touch-friendly.
      const hit = map
        .queryRenderedFeatures(
          [
            [e.point.x - 5, e.point.y - 5],
            [e.point.x + 5, e.point.y + 5],
          ],
          { layers: ["bike-network-solid"] }
        )
        .find((f) => f.properties && f.properties.supplement);
      if (hit) {
        showSupplementPopup(map, e.lngLat, hit.properties as Record<string, unknown>);
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
      map.off("mousemove", onDrawMove);
      map.off("touchmove", onDrawMove);
      map.off("mouseup", onDrawEnd);
      map.off("touchend", onDrawEnd);
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
  // class FeatureCollection here. Filling it also ends the transient drag draw.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;
    src.setData(routeFeatures);
    (
      map.getSource("route-drag") as maplibregl.GeoJSONSource | undefined
    )?.setData(emptyGeojson());

    // Fade the bike network back while a route is displayed so the route owns
    // the foreground (it's drawn in the same colors as the overlay beneath it).
    // Restore full opacity when the route is cleared.
    const hasRoute = routeFeatures.features.length > 0;
    if (map.getLayer("bike-network-solid")) {
      map.setPaintProperty("bike-network-solid", "line-opacity", hasRoute ? 0.35 : 0.85);
    }
    if (map.getLayer("bike-network-shared")) {
      map.setPaintProperty("bike-network-shared", "line-opacity", hasRoute ? 0.3 : 0.8);
    }
  }, [routeFeatures]);

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

  // ── Drawn strokes: repaint the vertex handles + pen marker when they change ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (
      map.getSource("draw-vertices") as maplibregl.GeoJSONSource | undefined
    )?.setData(strokeVertexFeatures(drawnStrokes));
    (
      map.getSource("draw-pen") as maplibregl.GeoJSONSource | undefined
    )?.setData(penFeature(drawnStrokes));
  }, [drawnStrokes]);

  // ── Personal connectors: repaint the teal "your fix" overlay on change ──
  // (community connectors are static — loaded once from the source data url).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (
      map.getSource("connectors-personal") as maplibregl.GeoJSONSource | undefined
    )?.setData(connectorFeatures(connectors));
  }, [connectors]);

  // ── Waypoint pins: repaint the handle layer whenever the via list changes ──
  // (a reshape adds/moves a via, a tap deletes one, endpoint changes clear them).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (
      map.getSource("route-waypoints") as maplibregl.GeoJSONSource | undefined
    )?.setData(waypointFeatures(vias));
  }, [vias]);

  // ── Toggle the waypoint handles' visibility with the editing modes ──
  // Pins show in Drag (reshape), Build (tap to add/remove), and Through (so the
  // user can see picked sections and tap one to remove it).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    if (map.getLayer("route-waypoints")) {
      map.setLayoutProperty(
        "route-waypoints",
        "visibility",
        editing || buildMode || corridorMode ? "visible" : "none"
      );
    }
  }, [editing, buildMode, corridorMode]);

  // ── Toggle the drawn-stroke handles + pen with Draw mode ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    for (const id of ["draw-vertices", "draw-pen"]) {
      if (map.getLayer(id)) {
        map.setLayoutProperty(id, "visibility", drawMode ? "visible" : "none");
      }
    }
  }, [drawMode]);

  // ── Corridor preview: highlight the picked section + its tapped endpoints ──
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    (
      map.getSource("corridor-preview") as maplibregl.GeoJSONSource | undefined
    )?.setData(
      corridorPreview
        ? lineFeature(corridorPreview.geometry.coordinates)
        : emptyGeojson()
    );
    const pts: GeoJSON.Feature[] = [];
    if (corridorA) pts.push(pointFeature(corridorA));
    if (corridorB) pts.push(pointFeature(corridorB));
    (
      map.getSource("corridor-points") as maplibregl.GeoJSONSource | undefined
    )?.setData({ type: "FeatureCollection", features: pts });
  }, [corridorA, corridorB, corridorPreview]);

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

  // ── Navigation chase camera ──────────────────────────────────────────────
  // On each GPS fix, ease the camera to the rider's position oriented to their
  // heading, pitched into a forward 3D view. Restore a flat north-up frame on exit.
  const wasNavigating = useRef(false);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (navCamera) {
      wasNavigating.current = true;
      map.easeTo({
        center: navCamera.center,
        bearing: navCamera.bearing,
        pitch: 55,
        zoom: 17,
        duration: 700,
      });
    } else if (wasNavigating.current) {
      wasNavigating.current = false;
      map.easeTo({ bearing: 0, pitch: 0, duration: 600 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navCamera?.version, navCamera === null]);

  return (
    <div className="map-wrapper">
      <div
        ref={containerRef}
        className="map-container"
        role="application"
        aria-label="Bike route map"
      />
      <div className="bike-legend-dock">
        <BikeNetworkLegend
          open={legendOpen}
          onToggle={() => setLegendOpen((o) => !o)}
          activePreset={activePreset}
          onSetPreset={setPreset}
          hiddenGroups={hiddenGroups}
          onToggleGroup={toggleGroup}
        />
        {comfortNoticeOpen && (
          <div className="bike-comfort-toast" role="status">
            <span className="bike-comfort-toast__text">
              We tidied the map — busy roads are hidden by default. Tap{" "}
              <strong>All</strong> to show everything.
            </span>
            <button
              type="button"
              className="bike-comfort-toast__dismiss"
              aria-label="Dismiss"
              onClick={() => setComfortNoticeOpen(false)}
            >
              ✕
            </button>
          </div>
        )}
      </div>
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
