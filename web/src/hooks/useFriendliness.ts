import { useState, useEffect } from "react";
import { classifyRoute, type RouteFriendliness } from "../friendliness";
import type { LngLat } from "../types";

/**
 * Classifies a route's coordinates into bike-friendliness tiers + coverage,
 * client-side against the bundled bike network. Re-runs whenever `coords`
 * identity changes (a fresh server route OR a hand-edit produces a new array).
 */
export function useFriendliness(
  coords: LngLat[] | null
): RouteFriendliness | null {
  const [result, setResult] = useState<RouteFriendliness | null>(null);

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
  }, [coords]);

  return result;
}
