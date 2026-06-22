/**
 * compare-engines.ts — offline bike-engine bake-off.
 *
 * Runs a set of origin/destination pairs through every routing engine
 * (Valhalla, BRouter, ORS, GraphHopper), scores each with the same metric the
 * live bake-off uses (route-scoring.ts), and prints a table with the per-OD
 * winner. Also dumps each engine's route to tests/results/ as GeoJSON so the
 * lines can be eyeballed side-by-side (geojson.io / an OpenFreeMap page).
 *
 * Headline OD: home (3703 NE 22nd Ave) → Trackers Earth SE — plus the 8
 * canonical routes for breadth. This both answers "do different ODs pick
 * different engines?" and validates that the live scoring picks sensible winners.
 *
 * Usage:
 *   ORS_API_KEY=… GRAPHHOPPER_API_KEY=… \
 *   VALHALLA_URL=… BROUTER_URL=… \
 *   npx tsx scripts/compare-engines.ts
 *
 * Engines with no key are skipped (logged), not failed. Valhalla + BRouter must
 * be reachable (local Docker, or point *_URL at the deployed services).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { getRoute } from "../server/src/services/valhalla.js";
import { getRouteBrouter } from "../server/src/services/brouter.js";
import { getRouteOrs } from "../server/src/experiments/engine-bakeoff/ors.js";
import { getRouteGraphHopper } from "../server/src/experiments/engine-bakeoff/graphhopper.js";
import { scoreRoutes } from "../server/src/experiments/engine-bakeoff/route-scoring.js";
import { EngineSkip, type EngineName } from "../server/src/experiments/engine-bakeoff/engine-skip.js";
import type { RouteResult } from "../server/src/services/valhalla.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CANONICAL_PATH = resolve(REPO_ROOT, "tests/routes/canonical.json");
const RESULTS_DIR = resolve(REPO_ROOT, "tests/results");

const PREFERENCE = (process.env.PREFERENCE ?? "comfort") as
  | "comfort"
  | "balanced"
  | "fast";

interface OD {
  id: string;
  name: string;
  from: [number, number]; // [lng, lat]
  to: [number, number];
}

interface CanonicalRoute {
  id: string;
  name: string;
  from: { lng: number; lat: number };
  to: { lng: number; lat: number };
}

const ENGINES: Array<{
  engine: EngineName;
  fn: (
    f: [number, number],
    t: [number, number],
    v: [number, number][],
    p: string
  ) => Promise<RouteResult>;
}> = [
  { engine: "valhalla", fn: (f, t, v, p) => getRoute(f, t, v, p as "comfort") },
  { engine: "brouter", fn: getRouteBrouter },
  { engine: "ors", fn: getRouteOrs },
  { engine: "graphhopper", fn: getRouteGraphHopper },
];

function pct(r: number): string {
  return (Math.round(r * 1000) / 10).toFixed(1) + "%";
}
function km(m: number): string {
  return (m / 1000).toFixed(2) + "km";
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function runOD(od: OD): Promise<void> {
  console.log(`\n==> ${od.id}: ${od.name}`);

  const settled = await Promise.allSettled(
    ENGINES.map((e) => e.fn(od.from, od.to, [], PREFERENCE))
  );

  const ok: Array<{ engine: EngineName; result: RouteResult }> = [];
  settled.forEach((s, i) => {
    const engine = ENGINES[i].engine;
    if (s.status === "fulfilled") {
      ok.push({ engine, result: s.value });
    } else if (s.reason instanceof EngineSkip) {
      console.log(`    ${pad(engine, 12)} skipped: ${s.reason.reason}`);
    } else {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.log(`    ${pad(engine, 12)} ERROR: ${msg.slice(0, 80)}`);
    }
  });

  if (ok.length === 0) {
    console.log("    (no engines returned a route)");
    return;
  }

  const ranked = scoreRoutes(ok, PREFERENCE);
  const winner = ranked[0].engine;

  console.log(
    `    ${pad("engine", 12)} ${pad("coverage", 9)} ${pad("dist", 9)} ${pad("forbid", 8)} score`
  );
  for (const r of ranked) {
    const mark = r.engine === winner ? "★" : " ";
    console.log(
      `  ${mark} ${pad(r.engine, 12)} ${pad(pct(r.coverage), 9)} ${pad(km(r.distance_m), 9)} ` +
        `${pad(r.forbidden_m + "m", 8)} ${r.score.toFixed(3)}`
    );
  }
  console.log(`    winner: ${winner}`);

  // Dump GeoJSON: one file per engine + a combined FeatureCollection per OD.
  await mkdir(RESULTS_DIR, { recursive: true });
  const features = ok.map(({ engine, result }) => ({
    type: "Feature" as const,
    properties: {
      engine,
      od: od.id,
      greenway_coverage: result.greenway_coverage,
      distance_m: result.distance_m,
      duration_s: result.duration_s,
      winner: engine === winner,
    },
    geometry: result.geometry,
  }));
  for (const f of features) {
    await writeFile(
      resolve(RESULTS_DIR, `${od.id}-${f.properties.engine}.geojson`),
      JSON.stringify({ type: "FeatureCollection", features: [f] }, null, 2)
    );
  }
  await writeFile(
    resolve(RESULTS_DIR, `${od.id}-all.geojson`),
    JSON.stringify({ type: "FeatureCollection", features }, null, 2)
  );
}

/** Parse "lng,lat" → [lng, lat], or null. */
function parseLngLat(s: string | undefined): [number, number] | null {
  if (!s) return null;
  const [lng, lat] = s.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

async function main(): Promise<void> {
  const canonical: CanonicalRoute[] = JSON.parse(
    await readFile(CANONICAL_PATH, "utf8")
  );

  // Single-OD override: set OD_FROM + OD_TO ("lng,lat") to run just that route
  // (avoids burning keyed-engine quota on the whole canonical set).
  const odFrom = parseLngLat(process.env.OD_FROM);
  const odTo = parseLngLat(process.env.OD_TO);

  const ods: OD[] =
    odFrom && odTo
      ? [
          {
            id: process.env.OD_ID ?? "custom",
            name: process.env.OD_NAME ?? "Custom OD",
            from: odFrom,
            to: odTo,
          },
        ]
      : [
          {
            id: "00-home-trackers",
            name: "Home (3703 NE 22nd) → Trackers Earth SE",
            from: [-122.6434, 45.5497],
            to: [-122.6505, 45.4942],
          },
          ...canonical.map((c) => ({
            id: c.id,
            name: c.name,
            from: [c.from.lng, c.from.lat] as [number, number],
            to: [c.to.lng, c.to.lat] as [number, number],
          })),
        ];

  console.log(`BikeRouteNicePDX — engine bake-off`);
  console.log(`preference: ${PREFERENCE}`);
  console.log(`engines: ${ENGINES.map((e) => e.engine).join(", ")}`);
  console.log(`ODs: ${ods.length}  (results → tests/results/<od>-<engine>.geojson)`);

  const winners = new Map<EngineName, number>();
  for (const od of ods) {
    await runOD(od);
  }

  // Tally winners across ODs by re-reading the combined files we just wrote.
  console.log(`\n=== winner tally ===`);
  for (const od of ods) {
    try {
      const fc = JSON.parse(
        await readFile(resolve(RESULTS_DIR, `${od.id}-all.geojson`), "utf8")
      ) as { features: Array<{ properties: { engine: EngineName; winner: boolean } }> };
      const w = fc.features.find((f) => f.properties.winner);
      if (w) winners.set(w.properties.engine, (winners.get(w.properties.engine) ?? 0) + 1);
    } catch {
      // skip ODs that produced no output
    }
  }
  for (const [engine, count] of [...winners.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${pad(engine, 12)} ${count} win(s)`);
  }
  console.log(
    `\nTip: open tests/results/00-home-trackers-all.geojson on geojson.io to compare lines.`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
