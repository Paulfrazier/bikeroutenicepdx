/**
 * BikeRouteNicePDX — server entry point
 *
 * Hono app on @hono/node-server.
 * Routes: POST /route, GET /search, GET /health
 *
 * Start dev:   npm run dev    (tsx --watch)
 * Start prod:  npm run build && npm run start
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { config } from "./config.js";
import routeHandler from "./routes/route.js";
import matchHandler from "./routes/match.js";
import corridorHandler from "./routes/corridor.js";
import searchHandler from "./routes/search.js";
import healthHandler from "./routes/health.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use("*", logger());

// CORS: allow the Vite dev server + every production web origin. WEB_ORIGIN is a
// comma-separated list so the same server serves the vercel.app alias AND the
// branded custom domains (pdxbikemap.frazierideas.com, pdxbikemap.fairpoint.website).
app.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = [
        "http://localhost:5173", // Vite default
        ...config.webOrigin
          .split(",")
          .map((o) => o.trim())
          .filter(Boolean),
      ];
      return allowed.includes(origin) ? origin : null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  })
);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.route("/route", routeHandler);
app.route("/match", matchHandler);
app.route("/corridor", corridorHandler);
app.route("/search", searchHandler);
app.route("/health", healthHandler);

// 404 fallback
app.notFound((c) => {
  return c.json({ error: "Not found", code: "not_found" }, 404);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  () => {
    console.log(`BikeRouteNicePDX server running on http://localhost:${config.port}`);
    console.log(`  Valhalla: ${config.valhallaUrl}`);
    console.log(`  Nominatim: ${config.nominatimUrl}`);
    console.log(`  CORS origin: ${config.webOrigin}`);
  }
);

export default app;
