/**
 * streetRatings.ts — the user's personal, global per-street opinions.
 *
 * Phase 1 of "rate your own streets": a small persistent map from a normalized
 * street NAME to a rating. The friendliness classifier (friendliness.ts) consults
 * this map at the moment it adopts a class for a route segment — if the matched
 * street has a rating, the rating's class REPLACES the data-derived one. Because
 * every route color AND the comfort-coverage fraction derive from that single
 * per-segment class, a rating propagates to both the map colors and the score for
 * free, everywhere that street appears (global by name).
 *
 * Ratings map onto EXISTING RouteClass values so nothing downstream changes:
 *   great → protected (purple)   good → greenway (green)
 *   bad   → shared   (gray dash) avoid → busy     (red dash, excluded from coverage)
 * Only `avoid` (→ busy) is removed from the comfort-coverage %; great/good/bad
 * recolor without changing the score. (Documented; can be revisited.)
 *
 * This file MUST stay in lockstep with the iOS StreetRatings.swift — same rating
 * names, same rating→class mapping, same name normalization — so a street rated
 * on one surface classifies identically on the other.
 *
 * Storage: localStorage (per-browser). Keyed by the NORMALIZED name so case /
 * whitespace / directional-prefix differences ("SW Naito Pkwy" vs "NW NAITO PKWY")
 * collapse to one global opinion ("NAITO PKWY").
 */

import type { RouteClass } from "./friendliness";

/** The four personal ratings, worst → best is avoid < bad < (default) < good < great. */
export type StreetRating = "great" | "good" | "bad" | "avoid";

export const STREET_RATINGS: readonly StreetRating[] = [
  "great",
  "good",
  "bad",
  "avoid",
];

/** Rating → existing RouteClass (KEEP IN SYNC WITH iOS StreetRatings.swift). */
export const RATING_TO_CLASS: Record<StreetRating, RouteClass> = {
  great: "protected",
  good: "greenway",
  bad: "shared",
  avoid: "busy",
};

/** Human label for the manage UI / quick-rate popup. */
export const RATING_LABEL: Record<StreetRating, string> = {
  great: "Great",
  good: "Good",
  bad: "Meh",
  avoid: "Avoid",
};

/**
 * A leading Portland directional — stripped so a street reads as ONE global
 * opinion across quadrants (e.g. SW & NW Naito → "NAITO PKWY"). Both the
 * abbreviated (PBOT bike-network: "SE 17TH AVE") and spelled-out (OSM arterials:
 * "Southeast 17th Avenue") forms are listed so the two data sources converge.
 */
const LEAD_DIRECTIONALS = new Set([
  "N", "NE", "E", "SE", "S", "SW", "W", "NW",
  "NORTH", "NORTHEAST", "EAST", "SOUTHEAST",
  "SOUTH", "SOUTHWEST", "WEST", "NORTHWEST",
]);

/**
 * Street-type suffix → canonical abbreviation, so PBOT's "AVE" and OSM's
 * "Avenue" land on the same key. Both forms map to the canonical value.
 */
const SUFFIX_CANON: Record<string, string> = {
  STREET: "ST", ST: "ST",
  AVENUE: "AVE", AVE: "AVE", AV: "AVE",
  BOULEVARD: "BLVD", BLVD: "BLVD",
  DRIVE: "DR", DR: "DR",
  ROAD: "RD", RD: "RD",
  PARKWAY: "PKWY", PKWY: "PKWY", PKY: "PKWY",
  PLACE: "PL", PL: "PL",
  COURT: "CT", CT: "CT",
  LANE: "LN", LN: "LN",
  TERRACE: "TER", TER: "TER", TERR: "TER",
  HIGHWAY: "HWY", HWY: "HWY",
  CIRCLE: "CIR", CIR: "CIR",
  TRAIL: "TRL", TRL: "TRL",
  WAY: "WAY", LOOP: "LOOP",
};

/**
 * Normalize a raw street name to its global key. Uppercase, drop punctuation,
 * strip a leading directional (full or abbreviated), and canonicalize the
 * street-type suffix — so the abbreviated PBOT names and spelled-out OSM names
 * for the SAME street collapse to one key ("SE 17TH AVE" = "Southeast 17th
 * Avenue" → "17TH AVE"). Numbered cross-streets in different quadrants merge by
 * design (the rating is global by name).
 *
 * MUST match iOS StreetRatings.normalize(_:) exactly.
 */
export function normalizeStreetName(raw: string): string {
  const tokens = raw
    .toUpperCase()
    .replace(/[.,]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return "";
  // Strip a leading directional only when something follows it.
  const body =
    tokens.length > 1 && LEAD_DIRECTIONALS.has(tokens[0])
      ? tokens.slice(1)
      : tokens;
  // Canonicalize the suffix (last token).
  const last = body.length - 1;
  const canon = SUFFIX_CANON[body[last]];
  if (canon) body[last] = canon;
  return body.join(" ");
}

// ── Store ─────────────────────────────────────────────────────────────────────

const STORAGE_KEY = "bikenice.streetRatings";

/** Normalized name → rating. */
type RatingsMap = Record<string, StreetRating>;

let cache: RatingsMap | null = null;
let overrideCache: Map<string, RouteClass> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): RatingsMap {
  if (cache) return cache;
  let parsed: RatingsMap = {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string" && (STREET_RATINGS as readonly string[]).includes(v)) {
          parsed[normalizeStreetName(k)] = v as StreetRating;
        }
      }
    }
  } catch {
    parsed = {};
  }
  cache = parsed;
  return cache;
}

function persist(): void {
  cache = cache ?? {};
  overrideCache = null;
  version++;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    /* storage full / disabled — keep the in-memory copy */
  }
  for (const cb of listeners) cb();
}

/** Monotonic change counter — a stable dependency for re-classifying the route. */
export function getVersion(): number {
  return version;
}

/** A snapshot of every rating as { name, rating } rows, sorted by name. */
export function ratingList(): Array<{ name: string; rating: StreetRating }> {
  const m = load();
  return Object.entries(m)
    .map(([name, rating]) => ({ name, rating }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Current rating for a raw or normalized name, or null. */
export function getRating(name: string): StreetRating | null {
  return load()[normalizeStreetName(name)] ?? null;
}

/** Set (or replace) the rating for a street. Name may be raw — it's normalized. */
export function setRating(name: string, rating: StreetRating): void {
  const key = normalizeStreetName(name);
  if (!key) return;
  cache = { ...load(), [key]: rating };
  persist();
}

/** Remove a street's rating (revert it to the data-derived class). */
export function removeRating(name: string): void {
  const key = normalizeStreetName(name);
  const m = { ...load() };
  if (!(key in m)) return;
  delete m[key];
  cache = m;
  persist();
}

/** True if the user has set any ratings (drives the "personalized" badge). */
export function hasRatings(): boolean {
  return Object.keys(load()).length > 0;
}

/**
 * The class-override map the classifier consults: normalized name → RouteClass.
 * Cached and rebuilt on change. The classifier stores already-normalized names on
 * its segments, so a lookup is a direct `.get`.
 */
export function overrides(): Map<string, RouteClass> {
  if (overrideCache) return overrideCache;
  const m = load();
  overrideCache = new Map();
  for (const [name, rating] of Object.entries(m)) {
    overrideCache.set(name, RATING_TO_CLASS[rating]);
  }
  return overrideCache;
}

/** Subscribe to rating changes (e.g. to re-classify the visible route). */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
