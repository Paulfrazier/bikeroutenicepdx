/**
 * DrawControlsBar.tsx — the compact mobile control strip shown while a
 * "from-scratch canvas" tool (Draw or Build) is active.
 *
 * Draw/Build need the map, not a panel: the full RouteDrawer (50–70vh) leaves
 * almost nothing to draw on. This collapses the bottom drawer to a single row of
 * the relevant controls so most of the map is interactive. Reuses the same
 * handlers as RouteDrawer's `.build-controls` — no new logic.
 */

interface DrawControlsBarProps {
  mode: "draw" | "build";
  /** Draw: number of strokes. Build: number of waypoints. */
  count: number;
  /** Remove the last stroke/waypoint (or undo the entry wipe when empty). */
  onUndo: () => void;
  /** Remove every stroke/waypoint at once. */
  onClear: () => void;
  /** True when entering Draw/Build wiped a route that Undo can still restore. */
  canRestore: boolean;
  /** Finish: Draw connects to the destination; Build links the waypoints. */
  onDone: () => void;
  /** Draw only: one-finger drag pans/zooms instead of drawing. (Two-finger
   * pan/pinch works even while unpaused; this is the discoverable fallback.) */
  drawPaused?: boolean;
  /** Draw only: toggle the pause (pan/zoom ⇄ draw). */
  onTogglePause?: () => void;
}

export function DrawControlsBar({
  mode,
  count,
  onUndo,
  onClear,
  canRestore,
  onDone,
  drawPaused,
  onTogglePause,
}: DrawControlsBarProps) {
  const noun = mode === "draw" ? "stroke" : "waypoint";
  const finishLabel = mode === "draw" ? "✓ Done" : "✓ Finish";
  return (
    <div className="draw-strip" role="group" aria-label="Draw controls">
      <span className="build-controls__count">
        {count} {count === 1 ? noun : `${noun}s`}
      </span>
      {mode === "draw" && (
        <button
          type="button"
          className={`build-controls__btn ${drawPaused ? "build-controls__btn--active" : ""}`}
          aria-pressed={drawPaused}
          onClick={onTogglePause}
        >
          {drawPaused ? "✏️ Draw" : "✋ Move"}
        </button>
      )}
      <button
        type="button"
        className="build-controls__btn"
        onClick={onUndo}
        disabled={count === 0 && !canRestore}
      >
        ↶ Undo
      </button>
      <button
        type="button"
        className="build-controls__btn"
        onClick={onClear}
        disabled={count === 0}
      >
        ✕ Clear
      </button>
      <button
        type="button"
        className="build-controls__btn build-controls__btn--primary"
        onClick={onDone}
        disabled={mode === "build" && count === 0}
      >
        {finishLabel}
      </button>
    </div>
  );
}
