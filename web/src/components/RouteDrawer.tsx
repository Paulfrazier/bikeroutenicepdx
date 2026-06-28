/**
 * RouteDrawer.tsx — the post-destination results body.
 *
 * Rendered identically in the desktop side panel and the mobile bottom drawer,
 * so the layout lives in ONE place. Order: summary pills → Start ride → Edit
 * route (collapsing the three reshape tools) → turn-by-turn directions.
 *
 * The three reshape tools (drag / draw / route-through-a-section) used to be
 * three always-visible buttons that out-shouted the primary "Start ride" CTA.
 * They're now grouped behind a single "Edit route" toggle that reveals a 3-way
 * mode selector — exactly one mode active at a time.
 */

import { RouteSummary } from "./RouteSummary";
import { DirectionsPanel } from "./DirectionsPanel";
import type { RouteStep } from "../types";

/** Which reshape mode is active, or null when the edit panel has none selected. */
export type EditTool = "through" | "drag" | "build" | "draw" | null;

interface RouteDrawerProps {
  distance_m: number;
  duration_s: number;
  coverage?: number;
  reshaped?: boolean;
  /** Coverage reflects the user's personal street ratings. */
  personalized?: boolean;
  onStartNav: () => void;
  /** Whether the edit panel (mode selector) is open. */
  editOpen: boolean;
  onToggleEdit: () => void;
  /** Currently active reshape mode (through/drag/build/draw) or null. */
  activeTool: EditTool;
  onSelectTool: (tool: Exclude<EditTool, null>) => void;
  /** Build mode: remove the last waypoint (or undo the wipe when empty). */
  onUndoWaypoint: () => void;
  /** Build mode: remove every waypoint at once. */
  onClearWaypoints: () => void;
  /** Build mode: link the waypoints into a route and exit Build. */
  onFinishBuild: () => void;
  /** Number of pass-through waypoints currently on the route. */
  waypointCount: number;
  /** Draw mode: remove the last stroke (or undo the wipe when empty). */
  onUndoStroke: () => void;
  /** Draw mode: remove every stroke at once. */
  onClearStrokes: () => void;
  /** Number of hand-drawn strokes on the route. */
  strokeCount: number;
  /** Draw mode: when true the map pans/zooms on drag instead of drawing. */
  drawPaused: boolean;
  /** Draw mode: toggle the pause (pan/zoom ⇄ draw). */
  onTogglePause: () => void;
  /** True when entering Build/Draw wiped a route that Undo can still restore. */
  canRestore: boolean;
  steps: RouteStep[];
  onStepClick: (loc: [number, number]) => void;
  /** Mobile collapses directions behind the drawer handle; desktop always shows. */
  showDirections: boolean;
}

const TOOLS: { id: Exclude<EditTool, null>; label: string; icon: string; hint: string }[] = [
  { id: "through", label: "Through", icon: "↦", hint: "Tap the start then the end of a section on the map. Tap a section's pin to remove it." },
  { id: "drag", label: "Drag", icon: "✎", hint: "Drag the route on the map to reshape it — it re-snaps to roads." },
  { id: "build", label: "Build", icon: "📍", hint: "Starts fresh from your start & end. Tap the map to drop waypoints (joined by straight lines); drag a pin to move it, tap a pin to remove it. Press ✓ Finish to link them into a route." },
  { id: "draw", label: "Draw", icon: "✏️", hint: "Starts fresh from your start & end. Draw the route in strokes (they snap to roads) — lift and continue where you left off. Tap “Move map” to pan/zoom, then resume. Drag a point to adjust." },
];

export function RouteDrawer({
  distance_m,
  duration_s,
  coverage,
  reshaped,
  personalized,
  onStartNav,
  editOpen,
  onToggleEdit,
  activeTool,
  onSelectTool,
  onUndoWaypoint,
  onClearWaypoints,
  onFinishBuild,
  waypointCount,
  onUndoStroke,
  onClearStrokes,
  strokeCount,
  drawPaused,
  onTogglePause,
  canRestore,
  steps,
  onStepClick,
  showDirections,
}: RouteDrawerProps) {
  const activeHint = TOOLS.find((t) => t.id === activeTool)?.hint;

  return (
    <>
      <RouteSummary
        distance_m={distance_m}
        duration_s={duration_s}
        coverage={coverage}
        reshaped={reshaped}
        personalized={personalized}
      />

      <div className="route-actions">
        <button type="button" className="start-nav-btn" onClick={onStartNav}>
          ▲ Start
        </button>

        <button
          type="button"
          className={`edit-route-btn ${editOpen ? "edit-route-btn--active" : ""}`}
          aria-pressed={editOpen}
          aria-expanded={editOpen}
          onClick={onToggleEdit}
        >
          {editOpen ? "✓ Done" : "✎ Edit"}
        </button>
      </div>

      {editOpen && (
        <div className="edit-tools" role="group" aria-label="Reshape mode">
          <div className="edit-tools__seg">
            {TOOLS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`edit-tools__btn ${activeTool === t.id ? "edit-tools__btn--active" : ""}`}
                aria-pressed={activeTool === t.id}
                onClick={() => onSelectTool(t.id)}
              >
                <span aria-hidden="true">{t.icon}</span> {t.label}
              </button>
            ))}
          </div>
          {activeHint && <p className="edit-tools__hint">{activeHint}</p>}
          {activeTool === "build" && (
            <div className="build-controls">
              <span className="build-controls__count">
                {waypointCount} {waypointCount === 1 ? "waypoint" : "waypoints"}
              </span>
              <button
                type="button"
                className="build-controls__btn"
                onClick={onUndoWaypoint}
                disabled={waypointCount === 0 && !canRestore}
              >
                ↶ Undo
              </button>
              <button
                type="button"
                className="build-controls__btn"
                onClick={onClearWaypoints}
                disabled={waypointCount === 0}
              >
                ✕ Clear
              </button>
              <button
                type="button"
                className="build-controls__btn build-controls__btn--primary"
                onClick={onFinishBuild}
                disabled={waypointCount === 0}
              >
                ✓ Finish
              </button>
            </div>
          )}
          {activeTool === "draw" && (
            <div className="build-controls">
              <span className="build-controls__count">
                {strokeCount} {strokeCount === 1 ? "stroke" : "strokes"}
              </span>
              <button
                type="button"
                className={`build-controls__btn ${drawPaused ? "build-controls__btn--active" : ""}`}
                aria-pressed={drawPaused}
                onClick={onTogglePause}
              >
                {drawPaused ? "✏️ Draw" : "✋ Move map"}
              </button>
              <button
                type="button"
                className="build-controls__btn"
                onClick={onUndoStroke}
                disabled={strokeCount === 0 && !canRestore}
              >
                ↶ Undo
              </button>
              <button
                type="button"
                className="build-controls__btn"
                onClick={onClearStrokes}
                disabled={strokeCount === 0}
              >
                ✕ Clear
              </button>
            </div>
          )}
        </div>
      )}

      {showDirections && (
        <DirectionsPanel steps={steps} onStepClick={onStepClick} />
      )}
    </>
  );
}
