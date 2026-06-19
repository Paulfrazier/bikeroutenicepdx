import { useState, useEffect } from "react";
import { fetchRoute } from "../api";
import type { LngLat, RouteResponse } from "../types";

/**
 * Fetches a route whenever both `from` and `to` are non-null.
 * A short debounce (400ms) prevents hammering the API while markers are
 * being dragged or endpoints are being updated rapidly.
 */
export function useRoute(from: LngLat | null, to: LngLat | null) {
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      fetchRoute({ from, to })
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
  }, [from, to]);

  return { route, loading, error };
}
