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
 * The debounce is split by what changed: typing in the address boxes (which
 * mutates `from`/`to` keystroke-by-keystroke) waits 400ms so we don't hammer the
 * API, but a deliberate drag-release/delete fires the re-route immediately so
 * editing feels snappy. Editing a STOP counts as an endpoint-class change — it
 * comes from a search box keystroke, not a drag — so it takes the slow path.
 */
const ENDPOINT_DEBOUNCE_MS = 400;
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

  // Track the previous endpoints AND stops so we can tell whether THIS change
  // came from an address box (debounce) or only from a drag (fire immediately).
  const prevEndpointsRef = useRef<string>("");

  useEffect(() => {
    if (!from || !to) {
      setRoute(null);
      setError(null);
      return;
    }

    const endpointKey = JSON.stringify([
      from,
      to,
      waypoints.filter((w) => w.stop).map((w) => w.at),
    ]);
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
