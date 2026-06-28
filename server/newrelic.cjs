'use strict'

/**
 * New Relic agent configuration for the BikeRouteNicePDX server.
 *
 * This package is ESM ("type": "module"), so the agent's config file MUST be
 * named `newrelic.cjs` (a plain `.js` would be parsed as ESM and fail to load).
 *
 * Privacy posture: backend APM ONLY, configured to capture ZERO user PII.
 * The Node agent already omits client IP, query params, request parameters, and
 * request bodies by default; the excludes below make that explicit and also drop
 * `request.uri` (the one default-captured attribute that can contain the
 * /search?q=<address> query string). See web/public/privacy.html.
 *
 * Secrets are NOT stored here — `NEW_RELIC_LICENSE_KEY` and `NEW_RELIC_APP_NAME`
 * come from the Railway environment. The agent is loaded before app code via
 * NODE_OPTIONS="--import newrelic/esm-loader.mjs -r newrelic" (Railway env var).
 */
exports.config = {
  app_name: [process.env.NEW_RELIC_APP_NAME || 'bikeroutenicepdx-server'],
  license_key: process.env.NEW_RELIC_LICENSE_KEY,

  // Trace-context headers only — propagates no user data.
  distributed_tracing: { enabled: true },
  logging: { level: 'info' },

  // Keep the default curated header allowlist (drops cookie/authorization/x-*).
  allow_all_headers: false,

  // --- PII stripping (defense in depth) ------------------------------------
  attributes: {
    exclude: [
      'request.uri', // /search?q=<address> — strip the query string
      'request.parameters.*', // belt: params are not captured by default anyway
      'request.headers.*', // strip IP-bearing headers (x-forwarded-for, etc.)
      'response.headers.*',
      'request.body' // POST /route, /match, /corridor coordinates
    ]
  },
  transaction_tracer: {
    enabled: true,
    attributes: {
      exclude: ['request.uri', 'request.parameters.*', 'request.headers.*']
    }
  },
  error_collector: {
    attributes: {
      exclude: ['request.uri', 'request.parameters.*', 'request.headers.*']
    }
  },

  // Last-resort redaction of any URL that still surfaces in a trace.
  url_obfuscation: {
    enabled: true,
    regex: { pattern: '.*', flags: '', replacement: '/[REDACTED]' }
  },

  // Do not forward application log lines (could contain user data).
  application_logging: { forwarding: { enabled: false } }
}
