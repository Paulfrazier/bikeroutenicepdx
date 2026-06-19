/**
 * Map.tsx — MapLibre GL map with:
 *   - Basemap: PMTiles (VITE_BASEMAP_URL) with fallback to demotiles OSM style
 *   - Bike network overlay: /bike-network.geojson (full Portland bike network,
 *     colored by facility class: greenway/protected/buffered/lane/path/shared)
 *   - Route line: live GeoJSON from useRoute (bold blue)
 *   - Start/end markers (green/red) placed on tap
 *   - User location dot via GeolocateControl
 *   - Legend card (bottom-left) showing facility class colors
 *
 * Basemap fallback note:
 *   VITE_BASEMAP_URL defaults to /portland.pmtiles which is gitignored (large
 *   binary). In dev without the file, the browser will 404 the pmtiles source
 *   and the map will silently show no basemap. To always have a visible
 *   basemap during dev, set VITE_BASEMAP_URL="" to skip pmtiles and load
 *   the OSM demotiles style instead.
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
import type { LngLat, RouteResponse } from "../types";

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

const BASEMAP_URL =
  (import.meta.env.VITE_BASEMAP_URL as string | undefined) ?? "/portland.pmtiles";
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

// ── Bike Network Legend ───────────────────────────────────────────────────────

const LEGEND_ITEMS = [
  { cls: "protected", color: "#6D28D9", label: "Protected Bike Lane",     dashed: false },
  { cls: "greenway",  color: "#2E9E48", label: "Neighborhood Greenway",   dashed: false },
  { cls: "path",      color: "#B45309", label: "Off-Street Path",         dashed: false },
  { cls: "buffered",  color: "#0891B2", label: "Buffered Bike Lane",      dashed: false },
  { cls: "lane",      color: "#F59E0B", label: "Bike Lane",               dashed: false },
  { cls: "shared",    color: "#9CA3AF", label: "Enhanced Shared Roadway", dashed: true  },
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
    </div>
  );
}

interface MapProps {
  from: LngLat | null;
  to: LngLat | null;
  route: RouteResponse | null;
  onMapClick: (lngLat: LngLat) => void;
  onStepFlyTo: LngLat | null;
}

export function Map({ from, to, route, onMapClick, onStepFlyTo }: MapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const fromMarkerRef = useRef<Marker | null>(null);
  const toMarkerRef = useRef<Marker | null>(null);

  // ── Initialize map ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    let style: string | maplibregl.StyleSpecification;
    if (BASEMAP_URL && BASEMAP_URL.endsWith(".pmtiles")) {
      ensurePmtilesProtocol().catch(console.error);
      style = pmtilesStyle(BASEMAP_URL);
    } else {
      // Fallback: free OSM raster style from MapLibre demotiles
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

      // ── Route line (added above greenways) ─────────────────────────────
      map.addSource("route", {
        type: "geojson",
        data: emptyGeojson(),
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: {
          "line-color": "#2563eb",
          "line-width": 6,
        },
      });
    });

    // ── Tap to set markers ─────────────────────────────────────────────
    map.on("click", (e) => {
      onMapClick([e.lngLat.lng, e.lngLat.lat]);
    });

    return () => {
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

  // ── Update route line source ─────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;

    const src = map.getSource("route") as maplibregl.GeoJSONSource | undefined;
    if (!src) return;

    if (route) {
      src.setData({
        type: "Feature",
        geometry: route.geometry,
        properties: {},
      });
      // Fit map to route bounds
      const coords = route.geometry.coordinates;
      if (coords.length > 1) {
        const bounds = coords.reduce(
          (b, c) => b.extend(c as LngLatLike),
          new maplibregl.LngLatBounds(coords[0] as LngLatLike, coords[0] as LngLatLike)
        );
        map.fitBounds(bounds, { padding: 60, maxZoom: 16 });
      }
    } else {
      src.setData(emptyGeojson());
    }
  }, [route]);

  // ── Sync from marker ─────────────────────────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    fromMarkerRef.current?.remove();
    if (from) {
      const el = document.createElement("div");
      el.className = "map-marker map-marker--from";
      el.setAttribute("aria-label", "Start point");
      fromMarkerRef.current = new Marker({ element: el })
        .setLngLat(from)
        .addTo(map);
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
      el.setAttribute("aria-label", "End point");
      toMarkerRef.current = new Marker({ element: el })
        .setLngLat(to)
        .addTo(map);
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
