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
   * Optional bake-off engines — used ONLY by the offline engine experiment
   * (server/src/experiments/engine-bakeoff/), never by the live /route path.
   * Both are free public APIs that require a key (no billing); inert when unset.
   */
  orsApiKey: process.env.ORS_API_KEY ?? "",
  // HeiGIT consolidated URL. The legacy api.openrouteservice.org host is
  // deprecated (announced 2026-04-28) and shuts down 2026-08-24; same key,
  // same request/response. Trailing slash is stripped (a trailing "/" → 405).
  orsUrl: (process.env.ORS_URL ?? "https://api.heigit.org/openrouteservice").replace(/\/$/, ""),
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
