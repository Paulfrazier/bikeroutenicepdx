/**
 * navigation.ts — pure helpers for live turn-by-turn navigation (web).
 *
 * Mirrors the iOS NavigationSession math. Builds on geo.ts (arcLengthAt,
 * haversineLength, closestPointOnSegmentMeters). No React, no MapLibre.
 */

import type { LngLat, RouteStep } from "./types";
import {
  haversineLength,
  arcLengthAt,
  closestPointOnSegmentMeters,
} from "./geo";

/** Shortest distance (m) from `target` to the polyline — min over all segments. */
export function distanceToPolyline(target: LngLat, coords: LngLat[]): number {
  if (coords.length < 2) {
    return coords.length === 1 ? haversineLength([target, coords[0]]) : Infinity;
  }
  let best = Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const proj = closestPointOnSegmentMeters(target, coords[i], coords[i + 1]);
    best = Math.min(best, haversineLength([target, proj]));
  }
  return best;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Initial bearing (deg, 0–360 clockwise from north) from a to b. */
export function bearing(a: LngLat, b: LngLat): number {
  const lat1 = a[1] * DEG2RAD;
  const lat2 = b[1] * DEG2RAD;
  const dLon = (b[0] - a[0]) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * RAD2DEG + 360) % 360;
}

/**
 * Bearing of the route ~`aheadM` meters ahead of the closest projection of
 * `pos` — used to orient the chase camera when GPS heading is unavailable.
 */
export function routeBearingAhead(
  pos: LngLat,
  coords: LngLat[],
  aheadM = 25
): number | null {
  if (coords.length < 2) return null;
  const arc = arcLengthAt(pos, coords);
  const here = pointAtArc(arc, coords);
  const ahead = pointAtArc(arc + aheadM, coords);
  if (!here || !ahead) return null;
  if (haversineLength([here, ahead]) < 1) return null;
  return bearing(here, ahead);
}

/** Point at `meters` along the polyline from its start (clamped). */
export function pointAtArc(meters: number, coords: LngLat[]): LngLat | null {
  if (!coords.length) return null;
  if (coords.length < 2 || meters <= 0) return coords[0];
  let remaining = meters;
  for (let i = 0; i < coords.length - 1; i++) {
    const seg = haversineLength([coords[i], coords[i + 1]]);
    if (remaining <= seg) {
      const t = seg === 0 ? 0 : remaining / seg;
      return [
        coords[i][0] + (coords[i + 1][0] - coords[i][0]) * t,
        coords[i][1] + (coords[i + 1][1] - coords[i][1]) * t,
      ];
    }
    remaining -= seg;
  }
  return coords[coords.length - 1];
}

/** Arc-length of each step's maneuver location along the route geometry. */
export function computeStepArcs(steps: RouteStep[], coords: LngLat[]): number[] {
  return steps.map((s) => arcLengthAt(s.location, coords));
}

/**
 * Comfort ranking of a bike-network class: 3 = calm/separated, 2 = buffered,
 * ≤1 = mixed-traffic / unknown. Used for greenway-aware announcements.
 */
export function protectionRank(cls: string | null): number {
  switch (cls) {
    case "off_street":
    case "greenway":
    case "protected":
      return 3;
    case "buffered":
      return 2;
    case "standard":
    case "residential":
    case "lane":
    case "collector":
      return 1;
    default:
      return 0;
  }
}

/** True for an actionable turn maneuver (vs. continue/start/arrive). */
export function isTurn(maneuver: string): boolean {
  const t = maneuver.toLowerCase();
  return (
    t.includes("left") ||
    t.includes("right") ||
    t.includes("roundabout") ||
    t.includes("rotary") ||
    t.includes("uturn") ||
    t.includes("u-turn")
  );
}

// ── Imperial formatting (Portland riders think in feet/miles) ────────────────

export function fmtDistanceImperial(m: number): string {
  const miles = m / 1609.344;
  if (miles < 0.1) return `${Math.round(m * 3.28084 / 10) * 10} ft`;
  return `${miles.toFixed(1)} mi`;
}

export function fmtEta(seconds: number): string {
  if (seconds <= 0) return "—";
  const min = Math.round(seconds / 60);
  if (min < 1) return "<1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

/** Spoken distance phrase ("in 300 feet", "in a quarter mile", "now"). */
export function spokenDistance(m: number): string {
  const feet = m * 3.28084;
  if (feet < 80) return "now";
  if (feet < 1000) return `in ${Math.round(feet / 50) * 50} feet`;
  const miles = m / 1609.344;
  if (miles < 0.3) return "in a quarter mile";
  if (miles < 0.6) return "in half a mile";
  if (miles < 0.85) return "in three quarters of a mile";
  return `in ${miles.toFixed(1)} miles`;
}

/** Same, without the leading "in " — for mid-sentence ("busy street for …"). */
export function spokenDistanceBare(m: number): string {
  const p = spokenDistance(m);
  return p.startsWith("in ") ? p.slice(3) : p;
}

/** Maneuver → emoji/arrow glyph for the HUD (mirrors DirectionsPanel). */
export function maneuverGlyph(type: string): string {
  const MAP: Record<string, string> = {
    depart: "🚲",
    arrive: "🏁",
    turn: "↩",
    "turn-left": "←",
    "turn-right": "→",
    "turn-slight-left": "↖",
    "turn-slight-right": "↗",
    "turn-sharp-left": "↰",
    "turn-sharp-right": "↱",
    "continue-straight": "↑",
    merge: "⤢",
    fork: "⑃",
    roundabout: "🔄",
    rotary: "🔄",
    "use-lane": "↑",
  };
  return MAP[type] ?? "↑";
}
