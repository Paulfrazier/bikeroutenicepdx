/**
 * tripProgress — resume record for an interrupted multi-stop trip.
 *
 * Web nav is foreground-only: a twenty-minute grocery stop will often lose the
 * tab, so this matters more here than on iOS, not less. Saved at every leg
 * transition, cleared on final arrival / End / cancel.
 *
 * MUST stay in lockstep with iOS `Services/TripProgress.swift` — same storage
 * key, same field names, same epoch-ms timestamp, same staleness cutoff. The
 * two stores never exchange bytes (localStorage vs UserDefaults); keeping the
 * shape identical is so the two surfaces stay reasoned about as one thing.
 *
 * Note the GPS trace is NOT persisted — resuming restores the *navigation*, not
 * the ride recording.
 */

export interface TripPlace {
  lat: number;
  lon: number;
  label?: string;
}

export interface TripProgress {
  version: number;
  /** Intermediate stops, in visiting order. */
  stops: TripPlace[];
  /** The final destination. Without it the last leg can't be reconstructed. */
  end: TripPlace;
  /** Leg being navigated when this was written. */
  legIndex: number;
  /** Epoch milliseconds — also the staleness clock. */
  startedAt: number;
}

/** Shared storage key — identical to the iOS `storageKey`. */
export const STORAGE_KEY = "bikenice.tripProgress";

/** Bumped when the shape changes; older records are dropped, not half-read. */
export const CURRENT_VERSION = 1;

/** A trip older than this is not offered for resume. */
export const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

function isPlace(v: unknown): v is TripPlace {
  if (typeof v !== "object" || v === null) return false;
  const p = v as Record<string, unknown>;
  return typeof p.lat === "number" && typeof p.lon === "number";
}

/** Runtime type guard — localStorage is user-writable and survives upgrades. */
function isTripProgress(v: unknown): v is TripProgress {
  if (typeof v !== "object" || v === null) return false;
  const t = v as Record<string, unknown>;
  return (
    t.version === CURRENT_VERSION &&
    Array.isArray(t.stops) &&
    t.stops.every(isPlace) &&
    isPlace(t.end) &&
    typeof t.legIndex === "number" &&
    typeof t.startedAt === "number"
  );
}

export function saveTripProgress(progress: TripProgress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    /* quota or disabled storage — resuming is a nicety, not a requirement */
  }
}

/** The saved trip, or null when absent, from an older schema, or stale. */
export function loadTripProgress(now = Date.now()): TripProgress | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isTripProgress(parsed)) return null;
    if (now - parsed.startedAt >= STALE_AFTER_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearTripProgress(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* nothing to do */
  }
}
