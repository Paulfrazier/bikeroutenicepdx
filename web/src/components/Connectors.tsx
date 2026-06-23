/**
 * Connectors.tsx — UI for the user's personal network "connectors" (drawn fixes).
 *
 *  - <ConnectorsButton>: a floating 🔧 button (mirrors StreetRatingsButton),
 *    stacked under the ★ ratings FAB; shows a dot when any connector exists.
 *  - <ConnectorsPanel>: a "My fixes" modal (mirrors StreetRatingsPanel) listing
 *    every connector with rename / delete / "Submit for review", plus a
 *    "Draw a fix on the map" CTA that enters connector draw mode.
 *
 * Persistence + the connector index live in ../connectors + ../friendliness; this
 * file is presentational. Reactivity comes from the store's version counter via
 * useSyncExternalStore, so any change re-renders the list (and, in App, the route).
 */

import { useMemo, useState, useSyncExternalStore } from "react";
import {
  listConnectors,
  renameConnector,
  removeConnector,
  hasConnectors,
  getVersion,
  subscribe,
  type Connector,
} from "../connectors";
import { submitFix } from "../api";
import "./Connectors.css";

/** Subscribe to the connector store's change counter (a stable snapshot). */
export function useConnectorsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** The user's personal connectors (re-renders on change). */
export function useConnectors(): Connector[] {
  const version = useConnectorsVersion();
  return useMemo(() => listConnectors(), [version]);
}

/** True when the user has any personal connector (re-renders on change). */
export function useHasConnectors(): boolean {
  const version = useConnectorsVersion();
  return useMemo(() => hasConnectors(), [version]);
}

/** Floating 🔧 button that opens the "My fixes" panel. */
export function ConnectorsButton({ onClick }: { onClick: () => void }) {
  const active = useHasConnectors();
  return (
    <button
      type="button"
      className="connectors-fab"
      onClick={onClick}
      aria-label="My fixes"
      title="My fixes"
    >
      <span aria-hidden="true">🔧</span>
      {active && <span className="connectors-fab__dot" aria-hidden="true" />}
    </button>
  );
}

type SubmitState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done"; url?: string }
  | { status: "error"; message: string };

/** One connector row: rename, delete, submit-for-review. */
function ConnectorRow({ connector }: { connector: Connector }) {
  const [submit, setSubmit] = useState<SubmitState>({ status: "idle" });

  const onSubmit = () => {
    setSubmit({ status: "pending" });
    submitFix({ coords: connector.coords, note: connector.name })
      .then((res) => setSubmit({ status: "done", url: res.url }))
      .catch((err: unknown) =>
        setSubmit({
          status: "error",
          message:
            err instanceof Error
              ? "Couldn't submit — try again later."
              : String(err),
        })
      );
  };

  return (
    <li className="connectors-row">
      <div className="connectors-row__top">
        <span className="connectors-row__swatch" aria-hidden="true" />
        <input
          className="connectors-row__name"
          type="text"
          defaultValue={connector.name ?? ""}
          placeholder="Name this fix (optional)"
          aria-label="Connector name"
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v !== (connector.name ?? "")) renameConnector(connector.id, v);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="connectors-row__actions">
        <button
          type="button"
          className="connectors-btn connectors-btn--primary"
          disabled={submit.status === "pending" || submit.status === "done"}
          onClick={onSubmit}
        >
          {submit.status === "pending"
            ? "Submitting…"
            : submit.status === "done"
              ? "Submitted"
              : "Submit for review"}
        </button>
        <button
          type="button"
          className="connectors-btn connectors-btn--danger"
          onClick={() => removeConnector(connector.id)}
        >
          Delete
        </button>
        {submit.status === "done" && (
          <span className="connectors-status connectors-status--done">
            Submitted — pending review
            {submit.url && (
              <>
                {" "}
                <a href={submit.url} target="_blank" rel="noopener noreferrer">
                  view
                </a>
              </>
            )}
          </span>
        )}
        {submit.status === "error" && (
          <span className="connectors-status connectors-status--error">
            {submit.message}
          </span>
        )}
      </div>
    </li>
  );
}

/** "My fixes" modal: list connectors, rename/delete/submit, or draw a new one. */
export function ConnectorsPanel({
  open,
  onClose,
  onDrawOnMap,
}: {
  open: boolean;
  onClose: () => void;
  onDrawOnMap: () => void;
}) {
  const list = useConnectors();

  if (!open) return null;

  return (
    <div
      className="guide-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="connectors-title"
      onClick={onClose}
    >
      <div className="guide-card" onClick={(e) => e.stopPropagation()}>
        <header className="guide-card__header">
          <h2 id="connectors-title" className="guide-card__title">
            My fixes
          </h2>
          <button
            type="button"
            className="guide-card__close"
            onClick={onClose}
            aria-label="Close my fixes"
          >
            ✕
          </button>
        </header>

        <div className="guide-card__body">
          <p className="connectors-intro">
            A <strong>fix</strong> is a short line you draw to patch a gap the
            router misses (a cycletrack it mislabels, a crossing it can't see).
            It's saved on this device, shown on the map, counted as comfortable,
            and spliced into routes that pass near both of its ends.
          </p>

          {list.length === 0 ? (
            <p className="connectors-empty">
              No fixes yet. Tap <strong>Draw a fix on the map</strong>, then drag
              over the gap at an intersection — lift to save it.
            </p>
          ) : (
            <ul className="connectors-list">
              {list.map((c) => (
                <ConnectorRow key={c.id} connector={c} />
              ))}
            </ul>
          )}
        </div>

        <footer className="guide-card__footer">
          <button
            type="button"
            className="guide-card__replay"
            onClick={onDrawOnMap}
          >
            ✏️ Draw a fix on the map
          </button>
        </footer>
      </div>
    </div>
  );
}
