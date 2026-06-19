/**
 * RouteSummary.tsx — pill bar: distance, duration, greenway coverage.
 *
 * greenway_coverage = 0 (server v0.1 limitation) → shows "—" with tooltip.
 */

interface RouteSummaryProps {
  distance_m: number;
  duration_s: number;
  greenway_coverage: number;
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
}: RouteSummaryProps) {
  const coveragePct = Math.round(greenway_coverage * 100);
  const coverageUnavailable = greenway_coverage === 0;

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
