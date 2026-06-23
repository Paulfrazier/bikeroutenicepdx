import { useState, useEffect, useSyncExternalStore } from "react";
import { classifyRoute, type RouteFriendliness } from "../friendliness";
import { subscribe, getVersion } from "../streetRatings";
import {
  subscribe as subscribeConnectors,
  getVersion as connectorsGetVersion,
} from "../connectors";
import type { LngLat } from "../types";

/**
 * Classifies a route's coordinates into bike-friendliness tiers + coverage,
 * client-side against the bundled bike network. Re-runs whenever `coords`
 * identity changes (a fresh server route OR a hand-edit produces a new array),
 * whenever the user's personal street ratings change, AND whenever the user's
 * connectors (drawn map-fixes) change — so a freshly rated street or drawn fix
 * recolors the visible route immediately.
 */
export function useFriendliness(
  coords: LngLat[] | null
): RouteFriendliness | null {
  const [result, setResult] = useState<RouteFriendliness | null>(null);
  const ratingsVersion = useSyncExternalStore(subscribe, getVersion, getVersion);
  const connVersion = useSyncExternalStore(
    subscribeConnectors,
    connectorsGetVersion,
    connectorsGetVersion
  );

  useEffect(() => {
    if (!coords || coords.length < 2) {
      setResult(null);
      return;
    }
    let cancelled = false;
    classifyRoute(coords)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      });
    return () => {
      cancelled = true;
    };
  }, [coords, ratingsVersion, connVersion]);

  return result;
}
