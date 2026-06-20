/**
 * bakeoff.ts — per-request engine bake-off.
 *
 * The best bike route isn't from a fixed engine: different origin/destination
 * pairs favor different routers. So on every /route request we fan out to all
 * available engines in parallel, score each with the project's greenway-coverage
 * metric (+ forbidden-arterial + detour penalties), and return the winner — with
 * the runners-up attached as `alternatives` so the client can show/switch
 * without a re-request.
 *
 * Engines:
 *   - Valhalla + BRouter: self-hosted, unlimited, always raced.
 *   - ORS + GraphHopper: free public APIs (keyed). Raced only when a key is set;
 *     an EngineSkip (no key / HTTP 429 quota) drops just that engine, never the
 *     request. A request fails only if *every* engine fails.
 *
 * A small in-memory TTL cache keys on rounded coordinates + preference, so
 * repeated identical requests (e.g. drag-to-reshape spam) don't re-hit the
 * quota-limited keyed engines.
 */

import { config } from "../config.js";
import { getRoute, ValhallaError, type RoutePreference } from "./valhalla.js";
import type { RouteResult } from "./valhalla.js";
import { getRouteBrouter } from "./brouter.js";
import { getRouteOrs } from "./ors.js";
import { getRouteGraphHopper } from "./graphhopper.js";
import { scoreRoutes } from "./route-scoring.js";
import { EngineSkip, type EngineName } from "./engine-skip.js";

export interface AlternativeRoute extends RouteResult {
  engine: EngineName;
  score: number;
}

export interface BakeoffResult extends RouteResult {
  /** Winning engine. */
  engine: EngineName;
  /** Runners-up, best-first — full geometry + steps so the UI can switch instantly. */
  alternatives: AlternativeRoute[];
}

interface Runner {
  engine: EngineName;
  run: () => Promise<RouteResult>;
}

// ---------------------------------------------------------------------------
// In-memory TTL cache (quota protection for the keyed engines)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; value: BakeoffResult }>();

function cacheKey(
  from: [number, number],
  to: [number, number],
  vias: [number, number][],
  preference: string
): string {
  const r = (c: [number, number]) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;
  return [preference, r(from), ...vias.map(r), r(to)].join("|");
}

function cacheGet(key: string): BakeoffResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key: string, value: BakeoffResult): void {
  cache.set(key, { at: Date.now(), value });
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value; // Map preserves insertion order
    if (oldest !== undefined) cache.delete(oldest);
  }
}

// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export async function bakeoffRoute(
  from: [number, number], // [lng, lat]
  to: [number, number], // [lng, lat]
  vias: [number, number][] = [],
  preference: RoutePreference = "comfort"
): Promise<BakeoffResult> {
  const key = cacheKey(from, to, vias, preference);
  const cached = cacheGet(key);
  if (cached) return cached;

  const runners: Runner[] = [
    { engine: "valhalla", run: () => getRoute(from, to, vias, preference) },
    { engine: "brouter", run: () => getRouteBrouter(from, to, vias, preference) },
  ];
  if (config.orsApiKey) {
    runners.push({ engine: "ors", run: () => getRouteOrs(from, to, vias, preference) });
  }
  if (config.graphhopperApiKey) {
    runners.push({
      engine: "graphhopper",
      run: () => getRouteGraphHopper(from, to, vias, preference),
    });
  }

  const settled = await Promise.allSettled(runners.map((r) => r.run()));

  const ok: Array<{ engine: EngineName; result: RouteResult }> = [];
  const errors: unknown[] = [];

  settled.forEach((s, i) => {
    const engine = runners[i].engine;
    if (s.status === "fulfilled") {
      ok.push({ engine, result: s.value });
    } else if (s.reason instanceof EngineSkip) {
      console.info(`[bakeoff] ${s.reason.message}`);
    } else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.warn(`[bakeoff] ${engine} failed: ${msg}`);
      errors.push(s.reason);
    }
  });

  if (ok.length === 0) {
    // Prefer surfacing a real engine error (e.g. "no route found") over a generic one.
    const ve = errors.find((e) => e instanceof ValhallaError) as ValhallaError | undefined;
    if (ve) throw ve;
    throw new ValhallaError("No routing engine returned a route", "no_route", 422);
  }

  const ranked = scoreRoutes(ok, preference);
  const [winner, ...rest] = ranked;

  const result: BakeoffResult = {
    ...winner.result,
    engine: winner.engine,
    alternatives: rest.map((r) => ({
      ...r.result,
      engine: r.engine,
      score: round2(r.score),
    })),
  };

  cacheSet(key, result);
  return result;
}
