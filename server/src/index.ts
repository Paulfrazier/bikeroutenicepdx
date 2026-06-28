/**
 * BikeRouteNicePDX — server entry point
 *
 * Hono app on @hono/node-server.
 * Routes: POST /route, GET /search, GET /health
 *
 * Start dev:   npm run dev    (tsx --watch)
 * Start prod:  npm run build && npm run start
 */

// New Relic must be imported FIRST — before Hono / @hono/node-server — so the
// agent initializes before the modules it instruments are evaluated. This
// top-of-file import IS the load mechanism: do NOT add a NODE_OPTIONS ESM-loader
// flag (the `--import newrelic/esm-loader.mjs` form breaks on newrelic v12 — see
// server/newrelic.cjs).
import newrelic from "newrelic";
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
import fixSubmitHandler from "./routes/fix-submit.js";

const app = new Hono();

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.use("*", logger());

// New Relic: name transactions by the matched route pattern (e.g. "POST /route",
// "GET /search") instead of the generic NormalizedUri fallback. `routePath` is the
// Hono route template, never the raw URL — so no query string or PII leaks into the
// transaction name. PII attributes are stripped in newrelic.cjs.
//
// IMPORTANT: routePath must be read AFTER `next()`. This middleware is registered
// on "*", so before the inner route matches, `c.req.routePath` is this middleware's
// own "/*" pattern — reading it early collapsed every transaction into "GET /*" /
// "POST /*". After `next()`, routePath resolves to the matched template (/search,
// /route, …). The transaction is still open here, so renaming takes effect.
app.use("*", async (c, next) => {
  await next();
  newrelic.setTransactionName(`${c.req.method} ${c.req.routePath}`);
});

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
app.route("/fix-submit", fixSubmitHandler);

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
