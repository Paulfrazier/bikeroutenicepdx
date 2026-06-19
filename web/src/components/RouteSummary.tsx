/**
 * RouteSummary.tsx — pill bar: distance, duration, greenway coverage.
 *
 * greenway_coverage = 0 (server v0.1 limitation) → shows "—" with tooltip.
 */

interface RouteSummaryProps {
  distance_m: number;
  duration_s: number;
  greenway_coverage: number;
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
  greenway_coverage,
  editedDistanceM,
  manuallyEdited = false,
}: RouteSummaryProps) {
  const coveragePct = Math.round(greenway_coverage * 100);
  const coverageUnavailable = greenway_coverage === 0;

  // Hand-edited mode: distance-only. Duration + greenway are stale, so hide them
  // rather than show a wrong number.
  if (manuallyEdited) {
    const editedDist = editedDistanceM ?? distance_m;
    return (
      <div className="route-summary" role="region" aria-label="Route summary">
        <span className="route-summary__pill route-summary__pill--distance">
          <span aria-label="Distance">{formatDistance(editedDist)}</span>
        </span>
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

      <span
        className={[
          "route-summary__pill",
          "route-summary__pill--greenway",
          coverageUnavailable ? "route-summary__pill--greenway-na" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-label={
          coverageUnavailable
            ? "Greenway coverage not yet available"
            : `${coveragePct}% greenway`
        }
        title={
          coverageUnavailable
            ? "Greenway coverage calculation is a v1.0 feature."
            : undefined
        }
      >
        {coverageUnavailable ? (
          <>🌳 <abbr title="Greenway coverage not yet available in v0.1">—</abbr></>
        ) : (
          <>🌳 {coveragePct}% greenway</>
        )}
      </span>
    </div>
  );
}
