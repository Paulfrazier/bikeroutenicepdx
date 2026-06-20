/**
 * POST /corridor
 *
 * "Route through this section." Resolves the literal street path between two
 * tapped points (A → B) and returns an ordered chain of pass-through points the
 * client injects as `via`s into the master /route call.
 *
 * Body: { a: [lng, lat], b: [lng, lat] }
 * Response: { points: [lng, lat][], geometry: LineString }
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { ValhallaError, resolveCorridor } from "../services/valhalla.js";

const app = new Hono();

const LngLat = z
  .tuple([z.number(), z.number()])
  .refine(
    ([lng, lat]) => lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90,
    { message: "Coordinate out of range — expected [lng, lat]" }
  );

const CorridorBody = z.object({
  a: LngLat,
  b: LngLat,
});

app.post(
  "/",
  zValidator("json", CorridorBody, (result, c) => {
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
    const { a, b } = c.req.valid("json");

    if (a[0] === b[0] && a[1] === b[1]) {
      return c.json(
        { error: "Corridor needs two different points", code: "invalid_request" },
        400
      );
    }

    try {
      const result = await resolveCorridor(a, b);
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
