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
export type EditTool = "drag" | "draw" | "through" | "build" | null;

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
  /** Currently active reshape mode (drag/draw/through) or null. */
  activeTool: EditTool;
  onSelectTool: (tool: Exclude<EditTool, null>) => void;
  /** Build mode: remove the last-added waypoint. */
  onUndoWaypoint: () => void;
  /** Build mode: remove every waypoint at once. */
  onClearWaypoints: () => void;
  /** Number of pass-through waypoints currently on the route. */
  waypointCount: number;
  /** Build: ON = tap to route waypoints; OFF = freehand sketch (visual only). */
  snapToRoads: boolean;
  onToggleSnap: () => void;
  /** Build + Snap OFF: number of freehand sketch strokes drawn. */
  sketchCount: number;
  /** Sketch: remove the last stroke / clear all strokes. */
  onUndoSketch: () => void;
  onClearSketch: () => void;
  steps: RouteStep[];
  onStepClick: (loc: [number, number]) => void;
  /** Mobile collapses directions behind the drawer handle; desktop always shows. */
  showDirections: boolean;
}

const TOOLS: { id: Exclude<EditTool, null>; label: string; icon: string; hint: string }[] = [
  { id: "build", label: "Build", icon: "📍", hint: "Tap the map to add waypoints one at a time; tap a waypoint to remove it." },
  { id: "drag", label: "Drag", icon: "✎", hint: "Drag the route on the map to reshape it — it re-snaps to roads." },
  { id: "draw", label: "Draw", icon: "✏️", hint: "Draw a segment on the map to force the route through it." },
  { id: "through", label: "Through", icon: "↦", hint: "Tap the start then the end of a section on the map." },
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
  waypointCount,
  snapToRoads,
  onToggleSnap,
  sketchCount,
  onUndoSketch,
  onClearSketch,
  steps,
  onStepClick,
  showDirections,
}: RouteDrawerProps) {
  const activeHint =
    activeTool === "build" && !snapToRoads
      ? "Drag on the map to sketch a freehand line (not routed)."
      : TOOLS.find((t) => t.id === activeTool)?.hint;

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
            <>
              <label className="snap-toggle">
                <input
                  type="checkbox"
                  checked={snapToRoads}
                  onChange={onToggleSnap}
                />
                <span>Snap to roads</span>
              </label>
              {snapToRoads ? (
                <div className="build-controls">
                  <span className="build-controls__count">
                    {waypointCount} {waypointCount === 1 ? "waypoint" : "waypoints"}
                  </span>
                  <button
                    type="button"
                    className="build-controls__btn"
                    onClick={onUndoWaypoint}
                    disabled={waypointCount === 0}
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
                </div>
              ) : (
                <div className="build-controls">
                  <span className="build-controls__count">
                    {sketchCount} {sketchCount === 1 ? "sketch" : "sketches"}
                  </span>
                  <button
                    type="button"
                    className="build-controls__btn"
                    onClick={onUndoSketch}
                    disabled={sketchCount === 0}
                  >
                    ↶ Undo
                  </button>
                  <button
                    type="button"
                    className="build-controls__btn"
                    onClick={onClearSketch}
                    disabled={sketchCount === 0}
                  >
                    ✕ Clear
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {showDirections && (
        <DirectionsPanel steps={steps} onStepClick={onStepClick} />
      )}
    </>
  );
}
