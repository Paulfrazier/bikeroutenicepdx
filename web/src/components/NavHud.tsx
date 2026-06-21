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
  };
  onEnd: () => void;
}

export function NavHud({ nav, onEnd }: NavHudProps) {
  const pillVariant = networkClassToVariant(nav.currentStep?.bicycle_network_class ?? null);

  return (
    <div className="nav-hud">
      {nav.arrived ? (
        <div className="nav-hud__banner nav-hud__banner--arrived">
          <span className="nav-hud__glyph" aria-hidden="true">🏁</span>
          <div className="nav-hud__banner-body">
            <span className="nav-hud__distance">You've arrived</span>
            <span className="nav-hud__instruction">Nice ride.</span>
          </div>
        </div>
      ) : (
        <div className="nav-hud__banner">
          <span className="nav-hud__glyph" aria-hidden="true">
            {maneuverGlyph(nav.nextStep?.maneuver_type ?? "continue-straight")}
          </span>
          <div className="nav-hud__banner-body">
            <span className="nav-hud__distance">
              {nav.rerouting ? "Rerouting…" : fmtDistanceImperial(nav.distanceToNext)}
            </span>
            <span className="nav-hud__instruction">
              {nav.nextStep?.instruction ?? "Continue on the route"}
            </span>
            {pillVariant !== "default" && (
              <span className={`nav-hud__pill nav-hud__pill--${pillVariant}`}>
                {PILL_LABELS[pillVariant]}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="nav-hud__panel">
        <div className="nav-hud__stats">
          <div className="nav-hud__stat">
            <span className="nav-hud__stat-value">{fmtEta(nav.timeRemaining)}</span>
            <span className="nav-hud__stat-label">ETA</span>
          </div>
          <div className="nav-hud__stat">
            <span className="nav-hud__stat-value">{fmtDistanceImperial(nav.distanceRemaining)}</span>
            <span className="nav-hud__stat-label">to go</span>
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
        <button type="button" className="nav-hud__end" onClick={onEnd}>
          {nav.arrived ? "Done" : "End"}
        </button>
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
