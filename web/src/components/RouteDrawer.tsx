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
export type EditTool = "drag" | "draw" | "through" | null;

interface RouteDrawerProps {
  distance_m: number;
  duration_s: number;
  coverage?: number;
  reshaped?: boolean;
  onStartNav: () => void;
  /** Whether the edit panel (mode selector) is open. */
  editOpen: boolean;
  onToggleEdit: () => void;
  /** Currently active reshape mode (drag/draw/through) or null. */
  activeTool: EditTool;
  onSelectTool: (tool: Exclude<EditTool, null>) => void;
  steps: RouteStep[];
  onStepClick: (loc: [number, number]) => void;
  /** Mobile collapses directions behind the drawer handle; desktop always shows. */
  showDirections: boolean;
}

const TOOLS: { id: Exclude<EditTool, null>; label: string; icon: string; hint: string }[] = [
  { id: "drag", label: "Drag", icon: "✎", hint: "Drag the route on the map to reshape it — it re-snaps to roads." },
  { id: "draw", label: "Draw", icon: "✏️", hint: "Draw a segment on the map to force the route through it." },
  { id: "through", label: "Through", icon: "↦", hint: "Tap the start then the end of a section on the map." },
];

export function RouteDrawer({
  distance_m,
  duration_s,
  coverage,
  reshaped,
  onStartNav,
  editOpen,
  onToggleEdit,
  activeTool,
  onSelectTool,
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
      />

      <button type="button" className="start-nav-btn" onClick={onStartNav}>
        ▲ Start ride
      </button>

      <button
        type="button"
        className={`edit-route-btn ${editOpen ? "edit-route-btn--active" : ""}`}
        aria-pressed={editOpen}
        aria-expanded={editOpen}
        onClick={onToggleEdit}
      >
        {editOpen ? "✓ Done editing" : "✎ Edit route"}
      </button>

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
        </div>
      )}

      {showDirections && (
        <DirectionsPanel steps={steps} onStepClick={onStepClick} />
      )}
    </>
  );
}
