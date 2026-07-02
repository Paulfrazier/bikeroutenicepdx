/**
 * useWakeLock — keep the screen on while `active` (Screen Wake Lock API).
 *
 * Web counterpart to iOS `isIdleTimerDisabled` during navigation. Sentinels
 * auto-release whenever the tab is hidden, so the hook re-acquires on
 * visibilitychange → visible. On browsers without the API (or when the
 * request is denied) it silently no-ops — Safari iOS ≥ 16.4 supports it.
 */

import { useEffect, useRef } from "react";

export function useWakeLock(active: boolean) {
  const sentinel = useRef<WakeLockSentinel | null>(null);

  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let cancelled = false;

    const acquire = async () => {
      if (cancelled || document.visibilityState !== "visible") return;
      try {
        sentinel.current = await navigator.wakeLock.request("screen");
      } catch {
        /* denied (low battery, browser policy) — ride on without it */
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      void sentinel.current?.release().catch(() => {});
      sentinel.current = null;
    };
  }, [active]);
}
