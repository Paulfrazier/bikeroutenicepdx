/**
 * POST /match
 *
 * Map-matches a freehand drawn trace onto the bike network (powers the iOS
 * finger-draw flow). Mirrors /route, but takes a polyline of drawn points
 * (plus optional start/end anchors) and returns the snapped route.
 *
 * Body: { trace: [[lng, lat], ...], start?: [lng, lat], end?: [lng, lat] }
 * Response: { geometry: LineString, distance_m, duration_s }
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { matchTrace, ValhallaError } from "../services/valhalla.js";

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

const MatchBody = z.object({
  // The decimated finger path. Min 2 points to define a path; cap at 2000 so a
  // pathological dense drag can't overwhelm Valhalla's matcher.
  trace: z
    .array(LngLat)
    .min(2, "trace needs at least 2 points")
    .max(2000, "trace has too many points"),
  start: LngLat.optional(),
  end: LngLat.optional(),
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

app.post(
  "/",
  zValidator("json", MatchBody, (result, c) => {
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
    const { trace, start, end } = c.req.valid("json");

    try {
      const result = await matchTrace(trace, { from: start, to: end });
      return c.json(result);
    } catch (err) {
      if (err instanceof ValhallaError) {
        return c.json({ error: err.message, code: err.code }, err.httpStatus);
      }
      const message = err instanceof Error ? err.message : "Internal server error";
      return c.json({ error: message, code: "internal_error" }, 500);
    }
  }
);

export default app;
