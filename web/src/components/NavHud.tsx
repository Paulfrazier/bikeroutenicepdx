/**
 * NavHud — the live turn-by-turn overlay (web). Top banner = next maneuver +
 * distance; bottom panel = ETA / distance-remaining + voice/calm toggles + the
 * big End button. The map shows through the gap between them.
 */

import type { NavView } from "../hooks/useNavigation";
import { networkClassToVariant } from "../types";
import {
  maneuverGlyph,
  fmtDistanceImperial,
  fmtEta,
} from "../navigation";

interface NavHudProps {
  nav: NavView & {
    setVoiceEnabled: (on: boolean) => void;
    setCalmMode: (on: boolean) => void;
    resume: () => void | Promise<void>;
    skipStop: () => void | Promise<void>;
    declareArrival: () => void;
  };
  onEnd: () => void;
}

/** Show the "then" preview chip once the current turn is this close (m). */
const THEN_PREVIEW_WITHIN_M = 150;

export function NavHud({ nav, onEnd }: NavHudProps) {
  const pillVariant = networkClassToVariant(nav.currentStep?.bicycle_network_class ?? null);
  const thenStep =
    nav.phase === "guiding" &&
    nav.followingStep &&
    nav.distanceToNext < THEN_PREVIEW_WITHIN_M
      ? nav.followingStep
      : null;
  const speedMph = Math.round(nav.speedMps * 2.23694);

  return (
    <div className="nav-hud">
      {nav.phase === "arrived" ? (
        <div className="nav-hud__banner nav-hud__banner--arrived">
          <span className="nav-hud__glyph" aria-hidden="true">🏁</span>
          <div className="nav-hud__banner-body">
            <span className="nav-hud__distance">You've arrived</span>
            <span className="nav-hud__instruction">Nice ride.</span>
          </div>
        </div>
      ) : nav.phase === "pausedAtStop" ? (
        /* Informational only — Continue / Skip live in the thumb zone below. */
        <div className="nav-hud__banner nav-hud__banner--arrived">
          <span className="nav-hud__glyph" aria-hidden="true">📍</span>
          <div className="nav-hud__banner-body">
            <span className="nav-hud__distance">
              {nav.legLabel ? `Arrived at ${nav.legLabel}` : "Arrived at your stop"}
            </span>
            <span className="nav-hud__instruction">
              {nav.resumeFailed
                ? "Couldn't fetch the next leg. Try again when you have signal."
                : "Take your time — guidance is paused."}
            </span>
          </div>
        </div>
      ) : (
        <div className="nav-hud__banner">
          <span className="nav-hud__glyph" aria-hidden="true">
            {maneuverGlyph(nav.nextStep?.maneuver_type ?? "continue")}
          </span>
          <div className="nav-hud__banner-body">
            <span className="nav-hud__distance">
              {nav.rerouting ? "Rerouting…" : fmtDistanceImperial(nav.distanceToNext)}
            </span>
            <span className="nav-hud__instruction">
              {nav.nextStep?.instruction ?? "Continue on the route"}
            </span>
            {thenStep && (
              <span className="nav-hud__then">
                then{" "}
                <span aria-hidden="true">{maneuverGlyph(thenStep.maneuver_type)}</span>{" "}
                {thenStep.street_name ?? thenStep.instruction}
              </span>
            )}
            {pillVariant !== "default" && (
              <span className={`nav-hud__pill nav-hud__pill--${pillVariant}`}>
                {PILL_LABELS[pillVariant]}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="nav-hud__panel">
        <div
          className="nav-hud__progress"
          role="progressbar"
          aria-valuenow={Math.round(nav.progress * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Route progress"
        >
          <div className="nav-hud__progress-fill" style={{ width: `${nav.progress * 100}%` }} />
        </div>
        {/* On a multi-stop trip the stats below describe the CURRENT leg. */}
        {nav.legProgressLabel && (
          <span className="nav-hud__leg-chip">{nav.legProgressLabel}</span>
        )}
        <div className="nav-hud__stats">
          <div className="nav-hud__stat">
            <span className="nav-hud__stat-value">{fmtEta(nav.timeRemaining)}</span>
            <span className="nav-hud__stat-label">ETA</span>
          </div>
          <div className="nav-hud__stat">
            <span className="nav-hud__stat-value">{fmtDistanceImperial(nav.distanceRemaining)}</span>
            <span className="nav-hud__stat-label">to go</span>
          </div>
          <div className="nav-hud__stat">
            <span className="nav-hud__stat-value">{speedMph}</span>
            <span className="nav-hud__stat-label">mph</span>
          </div>
          <div className="nav-hud__toggles">
            <button
              type="button"
              className={`nav-hud__toggle ${nav.voiceEnabled ? "nav-hud__toggle--on" : ""}`}
              aria-pressed={nav.voiceEnabled}
              aria-label={nav.voiceEnabled ? "Mute voice" : "Unmute voice"}
              onClick={() => nav.setVoiceEnabled(!nav.voiceEnabled)}
            >
              {nav.voiceEnabled ? "🔊" : "🔇"}
            </button>
            <button
              type="button"
              className={`nav-hud__toggle ${nav.calmMode ? "nav-hud__toggle--on" : ""}`}
              aria-pressed={nav.calmMode}
              aria-label={nav.calmMode ? "Calm mode on" : "Calm mode off"}
              title="Calm mode: only turns & busy-street warnings"
              onClick={() => nav.setCalmMode(!nav.calmMode)}
            >
              🍃
            </button>
          </div>
        </div>
        {/* Commit actions in the thumb zone, not up in the banner. */}
        {nav.phase === "pausedAtStop" ? (
          <div className="nav-hud__leg-actions">
            <button
              type="button"
              className="nav-hud__continue"
              onClick={() => void nav.resume()}
              disabled={nav.rerouting}
            >
              {nav.rerouting
                ? "Routing…"
                : nav.nextLegLabel
                  ? `Continue to ${nav.nextLegLabel}`
                  : "Continue"}
            </button>
            <div className="nav-hud__leg-actions-row">
              <button
                type="button"
                className="nav-hud__leg-secondary"
                onClick={() => void nav.skipStop()}
                disabled={nav.rerouting}
              >
                Skip stop
              </button>
              <button type="button" className="nav-hud__end" onClick={onEnd}>
                End trip
              </button>
            </div>
          </div>
        ) : (
          <>
            {nav.showManualArrival && (
              <button
                type="button"
                className="nav-hud__leg-secondary nav-hud__im-here"
                onClick={() => nav.declareArrival()}
              >
                I'm here
              </button>
            )}
            <button type="button" className="nav-hud__end" onClick={onEnd}>
              {nav.arrived ? "Done" : "End"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const PILL_LABELS: Record<string, string> = {
  greenway: "Greenway",
  protected: "Protected",
  residential: "Calm street",
  collector: "Collector",
  arterial: "Busy street",
};
