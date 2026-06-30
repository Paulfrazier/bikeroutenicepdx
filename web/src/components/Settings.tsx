/**
 * Settings.tsx — app settings FAB + modal.
 *
 *  - <SettingsButton>: a floating ⚙ button (mirrors StreetRatingsButton /
 *    ConnectorsButton) that opens the settings panel.
 *  - <SettingsPanel>: a modal (reuses the shared .guide-* card chrome) holding
 *    the routing-engine toggle (Self-build ↔ Prod). Self-build is the default;
 *    Prod stays available here for comparison/testing.
 *
 * Mirrors the FAB/modal conventions in StreetRatings.tsx / Connectors.tsx.
 */

import type { RouteEngine } from "../types";
import {
  ROUTE_ENGINES,
  ROUTE_ENGINE_LABEL,
  ROUTE_ENGINE_HINT,
} from "../routeEngine";
import "./Settings.css";

/** Floating ⚙ button that opens the settings panel. */
export function SettingsButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="settings-fab"
      onClick={onClick}
      aria-label="Settings"
      title="Settings"
    >
      <span aria-hidden="true">⚙</span>
    </button>
  );
}

/** Settings modal — currently the routing-engine toggle. */
export function SettingsPanel({
  open,
  onClose,
  engine,
  onEngineChange,
}: {
  open: boolean;
  onClose: () => void;
  engine: RouteEngine;
  onEngineChange: (engine: RouteEngine) => void;
}) {
  if (!open) return null;

  return (
    <div
      className="guide-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      onClick={onClose}
    >
      <div className="guide-card" onClick={(e) => e.stopPropagation()}>
        <header className="guide-card__header">
          <h2 id="settings-title" className="guide-card__title">
            Settings
          </h2>
          <button
            type="button"
            className="guide-card__close"
            onClick={onClose}
            aria-label="Close settings"
          >
            ✕
          </button>
        </header>

        <div className="guide-card__body">
          <section className="settings-section">
            <h3 className="settings-section__title">Routing engine</h3>
            <div
              className="settings-toggle"
              role="group"
              aria-label="Routing engine"
            >
              {ROUTE_ENGINES.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`settings-toggle__opt ${
                    engine === e ? "settings-toggle__opt--on" : ""
                  }`}
                  aria-pressed={engine === e}
                  onClick={() => onEngineChange(e)}
                >
                  {ROUTE_ENGINE_LABEL[e]}
                </button>
              ))}
            </div>
            <p className="settings-hint">{ROUTE_ENGINE_HINT[engine]}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
