import { useState, useEffect, useRef } from "react";
import { fetchRoute } from "../api";
import type { LngLat, RouteResponse, RoutePreference } from "../types";

/**
 * Fetches a route whenever both `from` and `to` are non-null. Optional `vias`
 * are ordered pass-through waypoints from drag-to-reshape — changing them
 * re-routes start → vias → end (snapped to real roads).
 *
 * The debounce is split by what changed: typing in the address boxes (which
 * mutates `from`/`to` keystroke-by-keystroke) waits 400ms so we don't hammer the
 * API, but a deliberate drag-release/delete (which only mutates `vias`) fires the
 * re-route immediately so editing feels snappy.
 */
const ENDPOINT_DEBOUNCE_MS = 400;
const VIA_DEBOUNCE_MS = 0;

export function useRoute(
  from: LngLat | null,
  to: LngLat | null,
  vias: LngLat[] = [],
  preference: RoutePreference = "comfort"
) {
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Serialize vias so the effect re-runs on value change, not array identity.
  const viaKey = JSON.stringify(vias);

  // Track the previous endpoints so we can tell whether THIS change came from
  // the endpoints (debounce) or only from a via edit (fire immediately).
  const prevEndpointsRef = useRef<string>("");

  useEffect(() => {
    if (!from || !to) {
      setRoute(null);
      setError(null);
      return;
    }

    const endpointKey = JSON.stringify([from, to]);
    const endpointsChanged = endpointKey !== prevEndpointsRef.current;
    prevEndpointsRef.current = endpointKey;
    const delay = endpointsChanged ? ENDPOINT_DEBOUNCE_MS : VIA_DEBOUNCE_MS;

    setLoading(true);
    setError(null);

    let cancelled = false;
    const timer = setTimeout(() => {
      fetchRoute({
        from,
        to,
        via: vias.length ? vias : undefined,
        preference,
      })
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
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, viaKey, preference]);

  return { route, loading, error };
}
