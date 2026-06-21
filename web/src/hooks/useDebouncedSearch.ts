import { useState, useEffect, useRef } from "react";
import { searchPlaces } from "../api";
import type { SearchResult } from "../types";

/** Minimum characters before we hit the geocoder — saves the scarce 1-rps budget. */
const MIN_QUERY_LENGTH = 3;

/**
 * Module-level client cache. Pairs with the server cache so repeated /
 * backspace-and-retype queries resolve synchronously with no network or spinner.
 */
const clientCache = new Map<string, SearchResult[]>();

function cacheKey(query: string): string {
  return query.trim().toLowerCase();
}

/**
 * Debounced wrapper around the /search endpoint.
 *
 * @param query - the raw text the user is typing
 * @param delayMs - debounce window (default 250ms)
 */
export function useDebouncedSearch(query: string, delayMs = 250) {
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const trimmed = query.trim();

    // Below the minimum length: clear everything, no fetch.
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    // Synchronous cache hit — instant, no spinner.
    const key = cacheKey(trimmed);
    const cached = clientCache.get(key);
    if (cached) {
      setResults(cached);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);

    if (timerRef.current) clearTimeout(timerRef.current);

    timerRef.current = setTimeout(() => {
      // Cancel any in-flight request before starting a new one.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      searchPlaces(trimmed, 5, controller.signal)
        .then((data) => {
          clientCache.set(key, data);
          if (!controller.signal.aborted) {
            setResults(data);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          // Aborted requests are expected — ignore them.
          if (err instanceof DOMException && err.name === "AbortError") return;
          if (controller.signal.aborted) return;
          setError(err instanceof Error ? err.message : String(err));
          setResults([]);
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, delayMs);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [query, delayMs]);

  return { results, loading, error };
}
