/**
 * RouteSummary.tsx — pill bar: distance, duration, bike-infra coverage.
 *
 * `coverage` is computed CLIENT-SIDE (see friendliness.ts) as the fraction of
 * the route on green+amber bike facilities. Undefined while it's being
 * classified → shows "—".
 */

interface RouteSummaryProps {
  distance_m: number;
  duration_s: number;
  /** 0–1 fraction of the route on bike infra (green+amber). */
  coverage?: number;
  /** Length of the hand-edited line (meters); used when manuallyEdited. */
  editedDistanceM?: number;
  /** When true, the route was dragged by hand: show distance-only, no stale stats. */
  manuallyEdited?: boolean;
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
  editedDistanceM,
  manuallyEdited = false,
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
          ? `${coveragePct}% on bike infrastructure`
          : "Bike infrastructure coverage being calculated"
      }
    >
      {coverageReady ? (
        <>🚲 {coveragePct}% on bike infra</>
      ) : (
        <>🚲 <abbr title="Calculating bike-infrastructure coverage…">—</abbr></>
      )}
    </span>
  );

  // Hand-edited mode: distance-only for duration (stale), but coverage is
  // re-classified for the edited line, so keep showing it.
  if (manuallyEdited) {
    const editedDist = editedDistanceM ?? distance_m;
    return (
      <div className="route-summary" role="region" aria-label="Route summary">
        <span className="route-summary__pill route-summary__pill--distance">
          <span aria-label="Distance">{formatDistance(editedDist)}</span>
        </span>
        {coveragePill}
        <span className="route-summary__note">Manually edited</span>
      </div>
    );
  }

  return (
    <div className="route-summary" role="region" aria-label="Route summary">
      <span className="route-summary__pill route-summary__pill--distance">
        <span aria-label="Distance">{formatDistance(distance_m)}</span>
      </span>

      <span className="route-summary__pill route-summary__pill--duration">
        <span aria-label="Estimated duration">{formatDuration(duration_s)}</span>
      </span>

      {coveragePill}
    </div>
  );
}
