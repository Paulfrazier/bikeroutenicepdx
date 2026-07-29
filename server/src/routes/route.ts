/**
 * POST /route
 *
 * Body: { from: [lng, lat], to: [lng, lat], via?: [lng, lat][] }
 * Response: RouteResult per API contract.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ValhallaError } from "../services/valhalla.js";
import { getRouteBrouter } from "../services/brouter.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const LngLat = z
  .tuple([z.number(), z.number()])
  .refine(
    ([lng, lat]) => lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90,
    { message: "Coordinate out of range — expected [lng, lat]" }
  );

/** Hard cap on user-declared stops (not total waypoints) — see MAX_STOPS on the clients. */
const MAX_STOPS = 8;

const RouteBody = z.object({
  from: LngLat,
  to: LngLat,
  // Ordered pass-through waypoints for drag-to-reshape. Capped so a runaway
  // edit can't overwhelm Valhalla.
  via: z.array(LngLat).max(50, "too many via points").optional(),
  /**
   * Ordered intermediate waypoints, tagged. Supersedes `via` when present.
   * `stop: true` marks a place the rider is actually going — it delimits a leg
   * and gets an "arrive at" step; untagged entries are drag-to-reshape vias and
   * behave exactly as `via` always has.
   */
  waypoints: z
    .array(
      z.object({
        at: LngLat,
        stop: z.boolean().optional(),
        label: z.string().max(120).optional(),
      })
    )
    .max(50, "too many waypoints")
    .optional(),
  // Greenway-vs-speed preference (ultra↔fast slider). Defaults to "comfort".
  // "ultra" prefers greenways/bike-infra hardest (custom BRouter safety-ultra).
  preference: z.enum(["ultra", "comfort", "balanced", "fast"]).optional(),
  // Routing-engine A/B: "prod" = stock brouter.de tiles, "selfbuild" = self-built
  // PBOT-patched tiles. Defaults to "prod". See docs/BROUTER_SELF_BUILD.md.
  engine: z.enum(["prod", "selfbuild"]).optional(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

app.post(
  "/",
  zValidator("json", RouteBody, (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: result.error.issues.map((i) => i.message).join("; "),
          code: "invalid_request",
        },
        400
      );
    }
  }),
  async (c) => {
    const { from, to, via, waypoints, preference, engine } = c.req.valid("json");

    // `waypoints` is the tagged superset of `via`; when it's absent everything
    // below collapses to exactly the pre-multi-stop behaviour.
    const chain = waypoints ?? (via ?? []).map((at) => ({ at }) as { at: [number, number]; stop?: boolean; label?: string });
    const viaCoords = chain.map((w) => w.at);
    const stops = chain
      .filter((w) => w.stop)
      .map((w) => ({ at: w.at, label: w.label }));

    if (stops.length > MAX_STOPS) {
      return c.json(
        { error: `too many stops (max ${MAX_STOPS})`, code: "invalid_request" },
        400
      );
    }

    // Reject if from === to with nothing in between (Valhalla would error anyway,
    // but friendlier message). With waypoints — including a loop trip that runs
    // home → errands → home — the route is well-defined even if endpoints match.
    if (from[0] === to[0] && from[1] === to[1] && viaCoords.length === 0) {
      return c.json(
        { error: "from and to must be different locations", code: "invalid_request" },
        400
      );
    }

    try {
      const result = await getRouteBrouter(
        from,
        to,
        viaCoords,
        preference ?? "comfort",
        engine ?? "prod",
        stops
      );
      return c.json(result);
    } catch (err) {
      if (err instanceof ValhallaError) {
        return c.json({ error: err.message, code: err.code }, err.httpStatus);
      }
      // Unexpected error
      const message = err instanceof Error ? err.message : "Internal server error";
      return c.json({ error: message, code: "internal_error" }, 500);
    }
  }
);

export default app;
