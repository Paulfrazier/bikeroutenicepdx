# Security Policy

BikeRouteNicePDX is a hobby/civic bike-routing app for Portland. There is no
user account system, no database, and no personal data stored server-side — the
backend is a stateless proxy in front of open routing/geocoding engines.

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue:

- Email: **paulfrazier@gmail.com** (subject line: `BikeRouteNicePDX security`)
- Or use GitHub's **private vulnerability reporting** (Security → Report a
  vulnerability) on this repository.

Please include reproduction steps and the affected endpoint/surface. Expect an
acknowledgement within a few days. There is no bounty program.

## What's in scope

- The API server (`server/`) — routing, matching, search, fix-submit endpoints.
- The web app (`web/`) and native iOS app (`ios/`).

## Hardening already in place

- All request input is schema-validated (Zod) with coordinate-range and
  array-size bounds; no database (no SQLi), no shell/`eval` (no RCE).
- Upstream hosts (BRouter, Valhalla, Nominatim, Photon, GitHub) are
  environment-configured, never derived from user input (no SSRF), and user
  values reach upstream URLs only via `URLSearchParams` / `encodeURIComponent`.
- Web rendering is React/JSX only (no `innerHTML`/`dangerouslySetInnerHTML`).
- Allowlist CORS; per-IP rate limiting on routing/search and on `/fix-submit`;
  security headers on both the API (`hono/secure-headers`) and the web app
  (`web/vercel.json`).
- User-submitted text in `/fix-submit` is rendered as fenced literals in the
  filed GitHub issue, so it cannot inject `@mentions`, links, images, or HTML.

## Operator checklist (deployment)

These are environment/config items, not code — verify them in Railway/Vercel:

1. **Private networking for engines.** The BRouter (`:17777`) and Valhalla
   (`:8002`) services are unauthenticated. They must be reachable only over
   Railway's private network from the API service — **not** exposed on a public
   domain. Confirm neither service has a public domain attached.
2. **Least-privilege GitHub token.** `GITHUB_FIX_TOKEN` should be a
   **fine-grained PAT** scoped to **Issues: write** on the single fix-queue repo
   only (not a classic `repo`-scope token), to bound blast radius if it leaks.
3. **Rate-limit trust.** The per-IP limiter trusts the right-most
   `X-Forwarded-For` hop (the one Railway appends). If the proxy topology
   changes, revisit `server/src/middleware/rateLimit.ts:clientIp`.
4. **CSP smoke test.** After deploying `web/vercel.json`, load a preview build
   in a real browser and confirm the map, geocoding search, and PWA install work
   with no Content-Security-Policy violations in the console before promoting to
   production. The CSP allows the OpenFreeMap/MapLibre tile origins and the
   Railway API origin; adjust `connect-src`/`img-src` if those origins change.
