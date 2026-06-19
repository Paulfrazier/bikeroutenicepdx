/**
 * GET /health
 *
 * Returns server status and Valhalla reachability.
 * Always returns HTTP 200 — callers should inspect the JSON to determine
 * whether the routing backend is functional.
 */

import { Hono } from "hono";
import { pingValhalla } from "../services/valhalla.js";

const app = new Hono();

app.get("/", async (c) => {
  const valhallaOk = await pingValhalla();
  return c.json({
    status: "ok",
    valhalla: valhallaOk ? "ok" : "down",
  });
});

export default app;
