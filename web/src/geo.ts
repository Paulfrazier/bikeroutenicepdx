/**
 * geo.ts — pure geometry helpers (no MapLibre import).
 *
 * Two coordinate worlds live here:
 *   - lng/lat tuples (LngLat) for great-circle length.
 *   - screen-pixel {x,y} points for hit-testing the drawn route line.
 *
 * The hit-test drives the raw drag-to-reshape interaction in Map.tsx:
 * pressing near an existing vertex drags it; pressing near a segment inserts
 * a fresh vertex at the pointer.
 */

import type { LngLat } from "./types";

// ── Great-circle length ────────────────────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** Total great-circle length of a polyline, in meters. */
export function haversineLength(coords: LngLat[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lng1, lat1] = coords[i - 1];
    const [lng2, lat2] = coords[i];
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    total += 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  return total;
}

/**
 * Index of the vertex in `coords` closest to `target` (great-circle).
 *
 * Mirrors iOS `GeoMath.nearestIndex`. Used to order drag-to-reshape via points:
 * since the current route passes through existing vias in order, a new via's
 * nearest-vertex index tells us where in the ordered via list it belongs.
 */
export function nearestVertexIndex(target: LngLat, coords: LngLat[]): number {
  if (coords.length === 0) return 0;
  let bestIndex = 0;
  let best = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineLength([coords[i], target]);
    if (d < best) {
      best = d;
      bestIndex = i;
    }
  }
  return bestIndex;
}

// ── Screen-pixel geometry ──────────────────────────────────────────────────

export interface Px {
  x: number;
  y: number;
}

/** Closest point to `p` on the segment a→b, in pixel space. */
export function closestPointOnSegment(p: Px, a: Px, b: Px): Px {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * dx, y: a.y + t * dy };
}

/** Distance from `p` to the segment a→b, in pixels. */
export function pointToSegmentDistancePx(p: Px, a: Px, b: Px): number {
  const c = closestPointOnSegment(p, a, b);
  return Math.hypot(p.x - c.x, p.y - c.y);
}

// ── Hit-test ───────────────────────────────────────────────────────────────

/** Grab radius (px) around an existing vertex — generous, fingers are fat. */
export const VERTEX_HIT_PX = 22;
/** Grab radius (px) around a bare segment, to insert a new vertex. */
export const SEGMENT_HIT_PX = 16;

export type HitResult =
  | { type: "vertex"; index: number }
  | { type: "segment"; index: number; point: Px }
  | null;

/**
 * Hit-test a pointer against the projected route.
 *
 * Vertices win over segments (checked first, larger radius) so the user can
 * always re-grab a point they just dropped. `segment.index` is the index of
 * the segment's first vertex — insert the new vertex at index+1.
 */
export function hitTestRoute(
  pointer: Px,
  vertices: Px[],
  vertexHitPx: number = VERTEX_HIT_PX,
  segmentHitPx: number = SEGMENT_HIT_PX
): HitResult {
  // 1) Existing vertices (closest within radius).
  let bestVertex = -1;
  let bestVertexDist = vertexHitPx;
  for (let i = 0; i < vertices.length; i++) {
    const d = Math.hypot(pointer.x - vertices[i].x, pointer.y - vertices[i].y);
    if (d <= bestVertexDist) {
      bestVertex = i;
      bestVertexDist = d;
    }
  }
  if (bestVertex !== -1) return { type: "vertex", index: bestVertex };

  // 2) Segments (closest within radius).
  let bestSeg = -1;
  let bestSegDist = segmentHitPx;
  let bestSegPoint: Px = pointer;
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i];
    const b = vertices[i + 1];
    const d = pointToSegmentDistancePx(pointer, a, b);
    if (d <= bestSegDist) {
      bestSeg = i;
      bestSegDist = d;
      bestSegPoint = closestPointOnSegment(pointer, a, b);
    }
  }
  if (bestSeg !== -1) {
    return { type: "segment", index: bestSeg, point: bestSegPoint };
  }

  return null;
}
