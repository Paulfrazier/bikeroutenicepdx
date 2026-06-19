import { useState, useEffect } from "react";
import { fetchRoute } from "../api";
import type { LngLat, RouteResponse } from "../types";

/**
 * Fetches a route whenever both `from` and `to` are non-null. Optional `vias`
 * are ordered pass-through waypoints from drag-to-reshape — changing them
 * re-routes start → vias → end (snapped to real roads).
 *
 * A short debounce (400ms) prevents hammering the API while markers/vias are
 * being updated rapidly.
 */
export function useRoute(
  from: LngLat | null,
  to: LngLat | null,
  vias: LngLat[] = []
) {
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Serialize vias so the effect re-runs on value change, not array identity.
  const viaKey = JSON.stringify(vias);

  useEffect(() => {
    if (!from || !to) {
      setRoute(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);

    let cancelled = false;
    const timer = setTimeout(() => {
      fetchRoute({ from, to, via: vias.length ? vias : undefined })
        .then((data) => {
          if (!cancelled) {
            setRoute(data);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setRoute(null);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, viaKey]);

  return { route, loading, error };
}
