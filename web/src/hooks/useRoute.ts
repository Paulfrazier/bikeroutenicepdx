import { useState, useEffect, useRef } from "react";
import { fetchRoute } from "../api";
import type {
  LngLat,
  RouteResponse,
  RoutePreference,
  RouteEngine,
  RouteWaypoint,
} from "../types";

/**
 * Fetches a route whenever both `from` and `to` are non-null. Optional
 * `waypoints` are ordered intermediate points — reshape vias from dragging, and
 * user-declared stops — routed start → waypoints → end.
 *
 * The debounce is split three ways by what changed:
 *
 *   - `from`/`to` mutate keystroke-by-keystroke while the rider types, so they
 *     wait 400ms rather than hammering the API.
 *   - A drag-release or delete is one deliberate act — fire immediately.
 *   - STOPS sit in between. They only change on a discrete commit (pick a
 *     result, remove, reorder), never mid-typing, so the 400ms endpoint path was
 *     pure dead time on every stop edit. But Move-up/Move-down can be tapped
 *     repeatedly, and each tap at 0ms would be its own request, so a short delay
 *     coalesces a burst of reorders into one route.
 */
const ENDPOINT_DEBOUNCE_MS = 400;
const STOP_DEBOUNCE_MS = 150;
const VIA_DEBOUNCE_MS = 0;

export function useRoute(
  from: LngLat | null,
  to: LngLat | null,
  waypoints: RouteWaypoint[] = [],
  preference: RoutePreference = "comfort",
  engine: RouteEngine = "selfbuild"
) {
  const [route, setRoute] = useState<RouteResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Serialize waypoints so the effect re-runs on value change, not array identity.
  const viaKey = JSON.stringify(waypoints);

  // Track the previous endpoints and stops SEPARATELY so we can tell which of
  // the three classes of change this was: address box, stop edit, or drag.
  const prevEndpointsRef = useRef<string>("");
  const prevStopsRef = useRef<string>("");

  useEffect(() => {
    if (!from || !to) {
      setRoute(null);
      setError(null);
      return;
    }

    const endpointKey = JSON.stringify([from, to]);
    const stopKey = JSON.stringify(waypoints.filter((w) => w.stop).map((w) => w.at));
    const endpointsChanged = endpointKey !== prevEndpointsRef.current;
    const stopsChanged = stopKey !== prevStopsRef.current;
    prevEndpointsRef.current = endpointKey;
    prevStopsRef.current = stopKey;
    const delay = endpointsChanged
      ? ENDPOINT_DEBOUNCE_MS
      : stopsChanged
        ? STOP_DEBOUNCE_MS
        : VIA_DEBOUNCE_MS;

    setLoading(true);
    setError(null);

    let cancelled = false;
    const timer = setTimeout(() => {
      fetchRoute({
        from,
        to,
        waypoints: waypoints.length ? waypoints : undefined,
        preference,
        engine,
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
  }, [from, to, viaKey, preference, engine]);

  return { route, loading, error };
}
