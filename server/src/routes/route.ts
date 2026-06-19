/**
 * POST /route
 *
 * Body: { from: [lng, lat], to: [lng, lat] }
 * Response: RouteResult per API contract.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { getRoute, ValhallaError } from "../services/valhalla.js";

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

const RouteBody = z.object({
  from: LngLat,
  to: LngLat,
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
    const { from, to } = c.req.valid("json");

    // Reject if from === to (Valhalla would error anyway, but friendlier message)
    if (from[0] === to[0] && from[1] === to[1]) {
      return c.json(
        { error: "from and to must be different locations", code: "invalid_request" },
        400
      );
    }

    try {
      const result = await getRoute(from, to);
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
