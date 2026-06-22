/**
 * Reads runtime config from environment variables.
 * Defaults are tuned for local development.
 */

export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  valhallaUrl: (process.env.VALHALLA_URL ?? "http://localhost:8002").replace(/\/$/, ""),
  /** BRouter engine — powers /route (greenway-preferring). /match stays on Valhalla. */
  brouterUrl: (process.env.BROUTER_URL ?? "http://localhost:17777").replace(/\/$/, ""),
  nominatimUrl: (process.env.NOMINATIM_URL ?? "https://nominatim.openstreetmap.org").replace(/\/$/, ""),
  /**
   * Photon (komoot) powers as-you-type autocomplete: fuzzy prefix matching plus
   * a lat/lon proximity bias toward Portland. Nominatim stays as the fallback
   * when Photon errors. Public instance has no key and no hard 1-rps limit (it's
   * built for typeahead), so we don't serialize requests against it.
   */
  photonUrl: (process.env.PHOTON_URL ?? "https://photon.komoot.io").replace(/\/$/, ""),
  /**
   * Optional bake-off engines. Both are free public APIs that require a key
   * (no billing). An engine with no key is automatically excluded from the
   * per-request bake-off, so the app still works on Valhalla + BRouter alone.
   */
  orsApiKey: process.env.ORS_API_KEY ?? "",
  orsUrl: (process.env.ORS_URL ?? "https://api.openrouteservice.org").replace(/\/$/, ""),
  graphhopperApiKey: process.env.GRAPHHOPPER_API_KEY ?? "",
  graphhopperUrl: (process.env.GRAPHHOPPER_URL ?? "https://graphhopper.com").replace(/\/$/, ""),
  /** Allowed CORS origin for the web frontend. */
  webOrigin: process.env.WEB_ORIGIN ?? "http://localhost:5173",
  /**
   * Path to the classified PBOT bike network GeoJSON used to compute per-step
   * greenway class + coverage. Defaults to the copy bundled under server/data
   * (kept in sync by scripts/export-bike-network.ts).
   */
  bikeNetworkPath: process.env.BIKE_NETWORK_PATH ?? "",
} as const;
