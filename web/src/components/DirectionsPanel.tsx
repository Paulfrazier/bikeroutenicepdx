/**
 * DirectionsPanel.tsx — scrollable list of turn-by-turn maneuvers.
 *
 * Each step shows:
 *   - A maneuver emoji derived from maneuver_type
 *   - Street name + instruction
 *   - Distance
 *   - Network class pill (green/blue/gray/orange/red)
 *
 * Tapping a step fires onStepClick(location) so the map can fly there.
 */

import type { RouteStep } from "../types";
import { networkClassToVariant } from "../types";
import type { LngLat } from "../types";

// ── Maneuver type → bicycle-friendly emoji ───────────────────────────────────
const MANEUVER_EMOJI: Record<string, string> = {
  depart: "🚲",
  arrive: "🏁",
  turn: "↩️",
  "turn-left": "←",
  "turn-right": "→",
  "turn-slight-left": "↖",
  "turn-slight-right": "↗",
  "turn-sharp-left": "↰",
  "turn-sharp-right": "↱",
  "continue-straight": "↑",
  merge: "⤢",
  "on-ramp": "⤴",
  "off-ramp": "⤵",
  fork: "⑃",
  "end-of-road": "🛑",
  roundabout: "🔄",
  rotary: "🔄",
  "roundabout-exit": "↗",
  "use-lane": "↑",
};

function maneuverEmoji(type: string): string {
  const normalized = type.toLowerCase().replace(/_/g, "-");
  return MANEUVER_EMOJI[normalized] ?? "🚲";
}

// ── Network class pill ───────────────────────────────────────────────────────
const PILL_LABELS: Record<string, string> = {
  greenway: "Greenway",
  protected: "Protected",
  residential: "Residential",
  collector: "Collector",
  arterial: "Arterial",
  default: "",
};

function NetworkPill({ cls }: { cls: string | null }) {
  const variant = networkClassToVariant(cls);
  if (variant === "default") return null;
  return (
    <span
      className={`directions-panel__pill directions-panel__pill--${variant}`}
      aria-label={`Road type: ${PILL_LABELS[variant]}`}
    >
      {PILL_LABELS[variant]}
    </span>
  );
}

// ── Distance formatting ──────────────────────────────────────────────────────
function fmtStepDist(m: number): string {
  if (m < 50) return `${Math.round(m)} m`;
  if (m < 1000) return `${Math.round(m / 10) * 10} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

// ── Component ────────────────────────────────────────────────────────────────
interface DirectionsPanelProps {
  steps: RouteStep[];
  onStepClick: (location: LngLat) => void;
}

export function DirectionsPanel({ steps, onStepClick }: DirectionsPanelProps) {
  if (steps.length === 0) {
    return (
      <div className="directions-panel directions-panel--empty">
        No turn-by-turn directions available.
      </div>
    );
  }

  return (
    <ol className="directions-panel" aria-label="Turn-by-turn directions">
      {steps.map((step, i) => (
        <li key={i} className="directions-panel__step">
          <button
            type="button"
            className="directions-panel__step-btn"
            onClick={() => onStepClick(step.location)}
            aria-label={`Step ${i + 1}: ${step.instruction}. ${fmtStepDist(step.distance_m)}.`}
          >
            <span className="directions-panel__step-icon" aria-hidden="true">
              {maneuverEmoji(step.maneuver_type)}
            </span>
            <span className="directions-panel__step-body">
              <span className="directions-panel__step-instruction">
                {step.instruction}
              </span>
              {step.street_name && (
                <span className="directions-panel__step-street">
                  {step.street_name}
                </span>
              )}
              <span className="directions-panel__step-meta">
                <span className="directions-panel__step-dist">
                  {fmtStepDist(step.distance_m)}
                </span>
                <NetworkPill cls={step.bicycle_network_class} />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
