/**
 * RouteSummary.tsx — pill bar: distance, duration, comfort coverage.
 *
 * `coverage` is computed CLIENT-SIDE (see friendliness.ts) as the fraction of
 * the route NOT on a busy road (green + amber + calm). Undefined while it's
 * being classified → shows "—".
 */

interface RouteSummaryProps {
  distance_m: number;
  duration_s: number;
  /** 0–1 fraction of the route on comfortable streets (not a busy road). */
  coverage?: number;
  /** When true, the route has been reshaped by dragging (re-snapped to roads). */
  reshaped?: boolean;
  /** When true, the coverage reflects the user's personal street ratings. */
  personalized?: boolean;
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(1)} km`;
}

function formatDuration(s: number): string {
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem > 0 ? `${h} h ${rem} min` : `${h} h`;
}

export function RouteSummary({
  distance_m,
  duration_s,
  coverage,
  reshaped = false,
  personalized = false,
}: RouteSummaryProps) {
  const coverageReady = coverage !== undefined;
  const coveragePct = coverageReady ? Math.round(coverage * 100) : 0;

  const coveragePill = (
    <span
      className={[
        "route-summary__pill",
        "route-summary__pill--greenway",
        coverageReady ? "" : "route-summary__pill--greenway-na",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-label={
        coverageReady
          ? `${coveragePct}% on comfortable streets`
          : "Comfort coverage being calculated"
      }
    >
      {coverageReady ? (
        <>🚲 {coveragePct}% comfortable</>
      ) : (
        <>🚲 <abbr title="Calculating comfort coverage…">—</abbr></>
      )}
    </span>
  );

  return (
    <div className="route-summary" role="region" aria-label="Route summary">
      <span className="route-summary__pill route-summary__pill--distance">
        <span aria-label="Distance">{formatDistance(distance_m)}</span>
      </span>

      <span className="route-summary__pill route-summary__pill--duration">
        <span aria-label="Estimated duration">{formatDuration(duration_s)}</span>
      </span>

      {coveragePill}

      {personalized && (
        <span
          className="route-summary__note route-summary__note--personalized"
          title="Reflects your personal street ratings"
        >
          ★ Personalized
        </span>
      )}

      {reshaped && <span className="route-summary__note">Reshaped</span>}
    </div>
  );
}
