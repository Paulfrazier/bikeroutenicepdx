import { useState, useCallback } from "react";
import type { LngLat } from "../types";

export interface GeolocationState {
  position: LngLat | null;
  error: string | null;
  loading: boolean;
}

/**
 * Returns the current device position (or an error) on demand.
 * Call `locate()` to trigger a geolocation request.
 */
export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    position: null,
    error: null,
    loading: false,
  });

  const locate = useCallback(() => {
    if (!navigator.geolocation) {
      setState((s) => ({
        ...s,
        error: "Geolocation is not supported by this browser.",
      }));
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setState({
          position: [pos.coords.longitude, pos.coords.latitude],
          error: null,
          loading: false,
        });
      },
      (err) => {
        setState({
          position: null,
          error: err.message,
          loading: false,
        });
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 }
    );
  }, []);

  return { ...state, locate };
}
