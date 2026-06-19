/**
 * service-worker.ts — v0.1 stub
 *
 * vite-plugin-pwa generates the actual SW from this file via Workbox.
 * In v0.1 we intentionally cache only the app shell (JS/CSS/HTML).
 *
 * TODO (v1.0): Add tile caching strategy:
 *   - PMTiles basemap: CacheFirst with large quota limit
 *   - Greenways GeoJSON: StaleWhileRevalidate, 24h expiry
 *   - Route API: NetworkFirst (never cache; routes must be fresh)
 *
 * Registered from main.tsx via vite-plugin-pwa's virtual:pwa-register module.
 */

// This file is intentionally minimal — Workbox handles the rest via
// vite.config.ts workbox.globPatterns. No custom fetch handlers in v0.1.

export {};
