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

import { Fragment } from "react";
import type { RouteStep, RouteLeg } from "../types";
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

function fmtLegDist(m: number): string {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`;
}

function fmtDuration(s: number): string {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

// ── Component ────────────────────────────────────────────────────────────────
interface DirectionsPanelProps {
  steps: RouteStep[];
  onStepClick: (location: LngLat) => void;
  /** Per-stop breakdown. When present, steps are grouped under a leg header. */
  legs?: RouteLeg[];
}

export function DirectionsPanel({ steps, onStepClick, legs }: DirectionsPanelProps) {
  if (steps.length === 0) {
    return (
      <div className="directions-panel directions-panel--empty">
        No turn-by-turn directions available.
      </div>
    );
  }

  return (
    <ol className="directions-panel" aria-label="Turn-by-turn directions">
      {steps.map((step, i) => {
        // A header opens each leg. Rendered inside the same <ol> so the list
        // stays one continuous sequence for screen readers and keyboard order.
        const leg = step.leg_index;
        const startsLeg =
          legs !== undefined &&
          leg !== undefined &&
          (i === 0 || steps[i - 1].leg_index !== leg);
        const legInfo = leg !== undefined ? legs?.[leg] : undefined;
        return (
        <Fragment key={i}>
        {startsLeg && legInfo && (
          <li className="directions-panel__leg-header">
            <span className="directions-panel__leg-title">
              {leg === 0 ? "To" : "Then to"}{" "}
              {legInfo.to_label ?? "your destination"}
            </span>
            <span className="directions-panel__leg-meta">
              {fmtLegDist(legInfo.distance_m)} · {fmtDuration(legInfo.duration_s)}
            </span>
          </li>
        )}
        <li className="directions-panel__step">
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
        </Fragment>
        );
      })}
    </ol>
  );
}
