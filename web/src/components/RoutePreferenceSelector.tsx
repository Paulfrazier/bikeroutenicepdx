/**
 * RoutePreferenceSelector.tsx — the greenway-vs-speed tier picker.
 *
 * A 4-segment control (Ultra · Comfort · Balanced · Fast) that mirrors the iOS
 * segmented control. Selecting a tier re-routes immediately (App owns the state
 * and feeds it to useRoute). The chosen tier persists across sessions.
 */

import type { RoutePreference } from "../types";
import {
  ROUTE_PREFERENCES,
  ROUTE_PREFERENCE_LABEL,
  ROUTE_PREFERENCE_HINT,
} from "../routePreference";
import "./RoutePreferenceSelector.css";

interface RoutePreferenceSelectorProps {
  value: RoutePreference;
  onChange: (pref: RoutePreference) => void;
}

export function RoutePreferenceSelector({
  value,
  onChange,
}: RoutePreferenceSelectorProps) {
  return (
    <div className="route-pref">
      <div
        className="route-pref__segments"
        role="radiogroup"
        aria-label="Routing preference"
      >
        {ROUTE_PREFERENCES.map((pref) => {
          const selected = pref === value;
          return (
            <button
              key={pref}
              type="button"
              role="radio"
              aria-checked={selected}
              className={[
                "route-pref__segment",
                selected ? "route-pref__segment--selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onChange(pref)}
            >
              {ROUTE_PREFERENCE_LABEL[pref]}
            </button>
          );
        })}
      </div>
      <p className="route-pref__hint" aria-live="polite">
        {ROUTE_PREFERENCE_HINT[value]}
      </p>
    </div>
  );
}
