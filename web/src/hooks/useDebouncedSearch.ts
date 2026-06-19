import { useState, useEffect, useRef } from "react";
import { searchPlaces } from "../api";
import type { SearchResult } from "../types";

/**
 * Debounced wrapper around the /search endpoint.
 *
 * @param query - the raw text the user is typing
 * @param delayMs - debounce window (default 300ms)
 */
export function useDebouncedSearch(query: string, delayMs = 300) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      let cancelled = false;

      searchPlaces(query)
        .then((data) => {
          if (!cancelled) {
            setResults(data);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : String(err));
            setResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });

      return () => {
        cancelled = true;
      };
    }, delayMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query, delayMs]);

  return { results, loading, error };
}
