/**
 * POST /fix-submit
 *
 * Accepts a user-submitted map "fix" (a drawn connector polyline) and files it
 * to the configured GitHub repository as an issue — the durable review queue.
 * (Railway's filesystem is ephemeral and there is no database.)
 *
 * Body:  { coords: [lng, lat][], note?: string, contact?: string }
 *
 * 200 → { status: "pending", url: <issue html_url> }
 * 400 → { error, code: "invalid_request" }   bad/missing body fields
 * 429 → { error, code: "rate_limited" }       >5 submissions / hour / IP
 * 503 → { error, code: "not_configured" }     GITHUB_FIX_TOKEN not set (dev)
 * 502 → { error, code: "upstream_error" }     GitHub API non-2xx / network err
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { config } from "../config.js";

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

const FixSubmitBody = z.object({
  coords: z.array(LngLat).min(2, "coords must have at least 2 points"),
  note: z.string().max(500, "note must be 500 characters or fewer").optional(),
  contact: z
    .string()
    .max(200, "contact must be 200 characters or fewer")
    .optional(),
});

// ---------------------------------------------------------------------------
// In-memory per-IP rate limiter  (5 submissions / hour / IP)
// ---------------------------------------------------------------------------

const rateLimitMap = new Map<string, number[]>();
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

/**
 * Returns true when the request is allowed; false when the limit is exceeded.
 * Timestamps older than the window are pruned on every call (lazy cleanup).
 */
function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const prev = (rateLimitMap.get(ip) ?? []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  if (prev.length >= RATE_LIMIT_MAX) {
    rateLimitMap.set(ip, prev); // keep pruned list, don't add timestamp
    return false;
  }
  rateLimitMap.set(ip, [...prev, now]);
  return true;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

app.post(
  "/",
  zValidator("json", FixSubmitBody, (result, c) => {
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
    // 503 when the token is absent — graceful for local/dev environments
    if (!config.githubFixToken) {
      return c.json(
        { error: "submissions not configured", code: "not_configured" },
        503
      );
    }

    // Rate limit keyed by the first forwarded IP, falling back to "local"
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0].trim() ?? "local";
    if (!checkRateLimit(ip)) {
      return c.json(
        { error: "too many submissions, try later", code: "rate_limited" },
        429
      );
    }

    const { coords, note, contact } = c.req.valid("json");

    // --- Build the GitHub issue ---

    const title =
      "[fix] " + (note?.slice(0, 72) || `connector ${coords.length} pts`);

    const lineString = { type: "LineString", coordinates: coords };
    const featureCollection = {
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: lineString }],
    };
    const previewUrl = `https://geojson.io/#data=data:application/json,${encodeURIComponent(
      JSON.stringify(featureCollection)
    )}`;

    const issueBody = [
      "## Submitted fix",
      "",
      `**Note:** ${note?.trim() || "(none)"}`,
      "",
      `**Contact:** ${contact?.trim() || "(none)"}`,
      "",
      "## GeoJSON",
      "",
      "```json",
      JSON.stringify(lineString, null, 2),
      "```",
      "",
      "## Preview",
      "",
      `[View on geojson.io](${previewUrl})`,
    ].join("\n");

    // --- POST to GitHub Issues API ---

    let response: Response;
    try {
      response = await fetch(
        `https://api.github.com/repos/${config.githubFixRepo}/issues`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.githubFixToken}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
            "User-Agent": "BikeRouteNicePDX",
          },
          body: JSON.stringify({ title, body: issueBody }),
        }
      );
    } catch (err) {
      // Network-level failure — do NOT surface token or raw message to client
      console.error(
        "[fix-submit] GitHub API network error:",
        err instanceof Error ? err.message : String(err)
      );
      return c.json(
        { error: "could not reach GitHub, try later", code: "upstream_error" },
        502
      );
    }

    if (!response.ok) {
      // Log status only; do NOT forward response body (may echo auth context)
      console.error(
        `[fix-submit] GitHub API ${response.status} for repo ${config.githubFixRepo.replace(/\/.*/, "/<repo>")}`
      );
      return c.json(
        {
          error: `issue creation failed (GitHub ${response.status})`,
          code: "upstream_error",
        },
        502
      );
    }

    const issue = (await response.json()) as { html_url: string };
    return c.json({ status: "pending", url: issue.html_url });
  }
);

export default app;
