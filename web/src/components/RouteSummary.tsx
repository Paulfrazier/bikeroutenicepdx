/**
 * RouteSummary.tsx — pill bar: distance, duration, comfort coverage.
 *
 * `coverage` is computed CLIENT-SIDE (see friendliness.ts) as the fraction of
 * the route NOT on a busy road (green + amber + calm). Undefined while it's
 * being classified → shows "—".
 */

/** Engine bake-off winner → short display label. */
const ENGINE_LABEL: Record<string, string> = {
  valhalla: "Valhalla",
  brouter: "BRouter",
  ors: "ORS",
  graphhopper: "GraphHopper",
};

interface RouteSummaryProps {
  distance_m: number;
  duration_s: number;
  /** 0–1 fraction of the route on comfortable streets (not a busy road). */
  coverage?: number;
  /** When true, the route has been reshaped by dragging (re-snapped to roads). */
  reshaped?: boolean;
  /** Winning engine of the per-request bake-off (omitted → no engine chip). */
  engine?: string;
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
  engine,
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

      {engine && (
        <span
          className="route-summary__pill route-summary__pill--engine"
          title={`Best of the bake-off: ${ENGINE_LABEL[engine] ?? engine}`}
          aria-label={`Routed by ${ENGINE_LABEL[engine] ?? engine}`}
        >
          via {ENGINE_LABEL[engine] ?? engine}
        </span>
      )}

      {reshaped && <span className="route-summary__note">Reshaped</span>}
    </div>
  );
}
