/**
 * EngineSkip — a non-fatal "drop this engine for this request" signal.
 *
 * Thrown by the optional keyed engines (ORS, GraphHopper) when they have no key
 * or hit their daily quota (HTTP 429). The bake-off filters these out silently
 * (logging a note) and proceeds with whatever engines did respond, so a missing
 * key or exhausted quota degrades gracefully instead of failing the route.
 */

export type EngineName = "valhalla" | "brouter" | "ors" | "graphhopper";

export class EngineSkip extends Error {
  constructor(
    public readonly engine: EngineName,
    public readonly reason: string
  ) {
    super(`${engine} skipped: ${reason}`);
    this.name = "EngineSkip";
  }
}
