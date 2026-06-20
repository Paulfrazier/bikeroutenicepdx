/**
 * Reads runtime config from environment variables.
 * Defaults are tuned for local development.
 */

export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  valhallaUrl: (process.env.VALHALLA_URL ?? "http://localhost:8002").replace(/\/$/, ""),
  nominatimUrl: (process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").replace(/\/$/, ""),
  /** Allowed CORS origin for the web frontend. */
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  /**
   * Path to the classified PBOT bike network GeoJSON used to compute per-step
   * greenway class + coverage. Defaults to the copy bundled under server/data
   * (kept in sync by scripts/export-bike-network.ts).
   */
  bikeNetworkPath: process.env.BIKE_NETWORK_PATH ?? "",
} as const;
