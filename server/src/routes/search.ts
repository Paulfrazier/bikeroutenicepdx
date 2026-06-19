/**
 * GET /search?q=<query>&limit=<n>
 *
 * Geocoding endpoint backed by Nominatim, biased to Portland metro bbox.
 * Default limit=5, max 10.
 */

import { Hono } from "hono";
import { geocodeSearch, NominatimError } from "../services/nominatim.js";

const app = new Hono();

app.get("/", async (c) => {
  const q = c.req.query("q");
  const limitParam = c.req.query("limit");

  // Validate q
  if (!q || q.trim().length === 0) {
    return c.json(
      { error: "Query parameter 'q' is required and must not be empty", code: "invalid_request" },
      400
    );
  }

  // Parse and clamp limit
  let limit = 5;
  if (limitParam !== undefined) {
    const parsed = parseInt(limitParam, 10);
    if (isNaN(parsed) || parsed < 1) {
      return c.json(
        { error: "'limit' must be a positive integer", code: "invalid_request" },
        400
      );
    }
    limit = Math.min(parsed, 10);
  }

  try {
    const results = await geocodeSearch(q.trim(), limit);
    return c.json(results);
  } catch (err) {
    if (err instanceof NominatimError) {
      return c.json({ error: err.message, code: err.code }, err.httpStatus);
    }
    const message = err instanceof Error ? err.message : "Internal server error";
    return c.json({ error: message, code: "internal_error" }, 500);
  }
});

export default app;
