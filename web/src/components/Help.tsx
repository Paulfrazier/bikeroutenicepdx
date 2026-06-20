/**
 * Help.tsx — first-run tour + reopenable gesture guide
 *
 * Two pieces share one visual language:
 *  - <Tour>: a slide-based onboarding walkthrough that auto-shows on first
 *    visit (gated by localStorage) and can be replayed from the guide.
 *  - <GestureGuide>: a cheat sheet of every map gesture (anchors + draw modes),
 *    grouped by mode, openable any time via the floating "?" button.
 *
 * Slide-based (not coach-marks anchored to live DOM) so it's robust to layout
 * and ports cleanly to the SwiftUI app.
 */

import { useState, useCallback, useEffect } from "react";

const TOUR_SEEN_KEY = "pdxgw_tour_seen_v1";

/** Has the first-run tour already been shown on this device? */
export function useFirstRunTour(): [boolean, () => void, () => void] {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(TOUR_SEEN_KEY)) setOpen(true);
    } catch {
      // localStorage blocked (private mode) — just skip the auto-tour.
    }
  }, []);

  const markSeen = useCallback(() => {
    try {
      localStorage.setItem(TOUR_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
  }, []);

  const close = useCallback(() => {
    markSeen();
    setOpen(false);
  }, [markSeen]);

  const replay = useCallback(() => setOpen(true), []);

  return [open, close, replay];
}

// ── Tour content ─────────────────────────────────────────────────────────────
type Slide = {
  icon: string;
  title: string;
  body: React.ReactNode;
};

const SLIDES: Slide[] = [
  {
    icon: "🚲",
    title: "Welcome to PDX Greenways",
    body: (
      <>
        Find calm, bike-friendly routes across Portland — built on the city's
        neighborhood greenway network. Here's how to drive it.
      </>
    ),
  },
  {
    icon: "📍",
    title: "Set your start & end",
    body: (
      <>
        Type an address up top, or just tap the map: the{" "}
        <strong>first tap</strong> sets your start, the{" "}
        <strong>second</strong> your destination. Tap once more to{" "}
        <strong>reset</strong>. Drag either marker to fine-tune it.
      </>
    ),
  },
  {
    icon: "🟢",
    title: "Read the route",
    body: (
      <>
        The line is colored by how bike-friendly each stretch is — from green{" "}
        <strong>greenways</strong> down to red <strong>arterials</strong>. The{" "}
        coverage % tells you how much of the ride is on calm streets.
      </>
    ),
  },
  {
    icon: "✎",
    title: "Reshape it by dragging",
    body: (
      <>
        Tap <strong>Edit route</strong>, then grab the line and drag it onto a
        street you'd rather take. It drops a waypoint that snaps to the nearest
        bike path and re-routes through it. Tap a dot to remove it.
      </>
    ),
  },
  {
    icon: "📌",
    title: "Precise anchors",
    body: (
      <>
        Want the route through an exact spot (a median crossing, a cut-through)?{" "}
        <strong>Long-press the line</strong> to drop a precise anchor — pinned
        exactly where you put it, no snapping.{" "}
        <strong>Long-press a dot</strong> to flip it between snap and precise.
      </>
    ),
  },
  {
    icon: "✏️",
    title: "Draw your own stretch",
    body: (
      <>
        Tap <strong>Draw segment</strong> and trace a path by hand. It's spliced
        into the route exactly as you drew it — perfect for a shortcut the router
        doesn't know. Drag any point afterward to tidy it up.
      </>
    ),
  },
  {
    icon: "↦",
    title: "Route through a section",
    body: (
      <>
        Tap <strong>Route through a section</strong>, then tap a street's start
        and end. The route is rerouted to flow down that whole stretch.
      </>
    ),
  },
  {
    icon: "✅",
    title: "You're set",
    body: (
      <>
        That's everything. Need a refresher later, tap the{" "}
        <strong>?</strong> button any time for the gesture guide.
      </>
    ),
  },
];

/** First-run / replayable onboarding walkthrough. */
export function Tour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [i, setI] = useState(0);

  // Always start at the first slide whenever the tour (re)opens.
  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  if (!open) return null;

  const slide = SLIDES[i];
  const isLast = i === SLIDES.length - 1;
  const next = () => (isLast ? onClose() : setI((n) => n + 1));
  const back = () => setI((n) => Math.max(0, n - 1));

  return (
    <div
      className="tour-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
    >
      <div className="tour-card">
        <button
          type="button"
          className="tour-card__skip"
          onClick={onClose}
          aria-label="Skip the tour"
        >
          Skip
        </button>

        <div className="tour-card__icon" aria-hidden="true">
          {slide.icon}
        </div>
        <h2 id="tour-title" className="tour-card__title">
          {slide.title}
        </h2>
        <p className="tour-card__body">{slide.body}</p>

        <div className="tour-card__dots" aria-hidden="true">
          {SLIDES.map((_, n) => (
            <span
              key={n}
              className={`tour-card__dot ${n === i ? "tour-card__dot--on" : ""}`}
            />
          ))}
        </div>

        <div className="tour-card__nav">
          <button
            type="button"
            className="tour-card__btn"
            onClick={back}
            disabled={i === 0}
          >
            Back
          </button>
          <span className="tour-card__count">
            {i + 1} / {SLIDES.length}
          </span>
          <button
            type="button"
            className="tour-card__btn tour-card__btn--primary"
            onClick={next}
          >
            {isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Gesture guide content ────────────────────────────────────────────────────
type Gesture = { do: string; gets: string };
type Group = { mode: string; hint?: string; gestures: Gesture[] };

const GROUPS: Group[] = [
  {
    mode: "📍 Set points",
    gestures: [
      { do: "Tap the map", gets: "1st = start · 2nd = end · 3rd = reset" },
      { do: "Drag a marker", gets: "Fine-tune the start or end spot" },
      { do: "Type an address", gets: "Search by place or address up top" },
    ],
  },
  {
    mode: "✎ Edit route — anchors",
    hint: "Tap “Edit route” first",
    gestures: [
      { do: "Drag the line", gets: "Drops a waypoint, snapped to the nearest bike path" },
      { do: "Long-press the line", gets: "Drops a precise anchor exactly there (no snap)" },
      { do: "Tap a dot", gets: "Removes that waypoint" },
      { do: "Long-press a dot", gets: "Toggles it between snap and precise" },
    ],
  },
  {
    mode: "✏️ Draw segment",
    hint: "Tap “Draw segment” first",
    gestures: [
      { do: "Trace on the map", gets: "Splices your hand-drawn path into the route" },
      { do: "Drag a point", gets: "Nudges a drawn point (kept exactly as-is)" },
    ],
  },
  {
    mode: "↦ Route through a section",
    hint: "Tap “Route through a section” first",
    gestures: [
      { do: "Tap start, then end", gets: "Reroutes down that whole stretch of street" },
    ],
  },
];

/** Reopenable cheat sheet of every map gesture. */
export function GestureGuide({
  open,
  onClose,
  onReplayTour,
}: {
  open: boolean;
  onClose: () => void;
  onReplayTour: () => void;
}) {
  if (!open) return null;

  return (
    <div
      className="guide-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="guide-title"
      onClick={onClose}
    >
      <div className="guide-card" onClick={(e) => e.stopPropagation()}>
        <header className="guide-card__header">
          <h2 id="guide-title" className="guide-card__title">
            Gesture guide
          </h2>
          <button
            type="button"
            className="guide-card__close"
            onClick={onClose}
            aria-label="Close gesture guide"
          >
            ✕
          </button>
        </header>

        <div className="guide-card__body">
          {GROUPS.map((g) => (
            <section key={g.mode} className="guide-group">
              <h3 className="guide-group__mode">{g.mode}</h3>
              {g.hint && <p className="guide-group__hint">{g.hint}</p>}
              <ul className="guide-group__list">
                {g.gestures.map((ge) => (
                  <li key={ge.do} className="guide-row">
                    <span className="guide-row__do">{ge.do}</span>
                    <span className="guide-row__gets">{ge.gets}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <footer className="guide-card__footer">
          <button
            type="button"
            className="guide-card__replay"
            onClick={() => {
              onClose();
              onReplayTour();
            }}
          >
            ▶ Replay the tour
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Floating "?" button that opens the gesture guide. */
export function HelpButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="help-fab"
      onClick={onClick}
      aria-label="Open the gesture guide"
      title="How to use the map"
    >
      ?
    </button>
  );
}
