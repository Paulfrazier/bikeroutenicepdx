/**
 * compare-facility.ts — PROTOTYPE: does steering BRouter with PBOT facility data help?
 *
 * BRouter routes on stock OSM (brouter.de segments); it never sees PBOT's facility
 * classification, so it avoids built buffered/protected lanes that OSM tags as
 * busy tertiary streets (e.g. SE 17th Ave). This offline harness measures whether
 * a PBOT-facility-aware SELECTION layer on top of BRouter helps, WITHOUT touching
 * the graph or profiles:
 *
 *   A (baseline) = plain BRouter alternativeidx=0 (today's prod route).
 *   B (facility) = best of {BRouter alts 0..2} ∪ {candidates forced onto the
 *                  nearest along-corridor PBOT lane via injected vias}, ranked by
 *                  a scorer that rewards buffered+protected distance vs detour.
 *
 * Per OD it prints greenway%, buffered%, facility% (buffered+protected), distance,
 * detour% (B vs A), and which candidate won; dumps A/B/spine GeoJSON to
 * tests/results/ for eyeballing on geojson.io.
 *
 * Usage (BRouter must be reachable; brouter.de works for the standard `safety`
 * profile, i.e. preference=comfort):
 *   BROUTER_URL=https://brouter.de npx tsx scripts/compare-facility.ts
 *   BROUTER_URL=https://brouter.de OD_FROM=-122.6452,45.5012 OD_TO=-122.6498,45.4822 \
 *     OD_ID=se17th npx tsx scripts/compare-facility.ts
 *
 * Notes:
 *  - "ultra" maps to safety-ultra which only exists on our own brouter-service;
 *    against brouter.de it falls back to safety (warned).
 *  - The prototype scorer omits the forbidden-street penalty (candidates are
 *    geometry-only with no step names); the eventual /route integration, which
 *    assembles steps, restores it. Detour cap + greenway/facility weighting carry
 *    the load here.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchBrouterGeometry,
  type BrouterGeometry,
} from "../server/src/services/brouter.js";
import {
  facilitiesInCorridor,
  facilityMeters,
  GREENWAY_EQUIVALENT,
  type NetworkClass,
} from "../server/src/services/greenway-coverage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const CANONICAL_PATH = resolve(REPO_ROOT, "tests/routes/canonical.json");
const RESULTS_DIR = resolve(REPO_ROOT, "tests/results");

const PREFERENCE = process.env.PREFERENCE ?? "comfort";

/** preference → standard BRouter profile (safety-ultra is our-service-only). */
const PROFILE_BY_PREFERENCE: Record<string, string> = {
  ultra: "safety-ultra",
  comfort: "safety",
  balanced: "trekking",
  fast: "fastbike",
};

/** Score weights per preference. green ≥ fac everywhere; no forbid term (see header). */
const WEIGHTS: Record<string, { green: number; fac: number; dist: number }> = {
  ultra: { green: 1.0, fac: 0.7, dist: 0.6 },
  comfort: { green: 1.0, fac: 0.5, dist: 0.8 },
  balanced: { green: 0.6, fac: 0.2, dist: 1.0 },
  fast: { green: 0.25, fac: 0.0, dist: 1.6 },
};

const BUFFERED = new Set<NetworkClass>(["buffered"]);
const FACILITY = new Set<NetworkClass>(["buffered", "protected"]);

interface OD {
  id: string;
  name: string;
  from: [number, number];
  to: [number, number];
}

interface CanonicalRoute {
  id: string;
  name: string;
  from: { lng: number; lat: number };
  to: { lng: number; lat: number };
}

interface Candidate {
  label: string; // idx0 | idx1 | fac-mid | fac-thirds | fac-quarters | ...
  geom: BrouterGeometry;
  greenwayCov: number;
  bufferedCov: number;
  facilityCov: number;
  detour: number;
  score: number;
}

function pct(r: number): string {
  return (Math.round(r * 1000) / 10).toFixed(1) + "%";
}
function km(m: number): string {
  return (m / 1000).toFixed(2) + "km";
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

/** Pick spine points at the given along-fractions (0..1), deduped, in order. */
function pickVias(
  spine: [number, number][],
  fractions: number[]
): [number, number][] {
  const n = spine.length;
  if (n === 0) return [];
  const idxs = Array.from(
    new Set(fractions.map((f) => Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))))
  ).sort((a, b) => a - b);
  return idxs.map((i) => spine[i]);
}

/** Dedup key for a route geometry (length + endpoints + vertex count). */
function geomKey(g: BrouterGeometry): string {
  const a = g.coords[0];
  const b = g.coords[g.coords.length - 1];
  return `${g.distance_m}:${g.coords.length}:${a[0].toFixed(5)},${a[1].toFixed(5)}:${b[0].toFixed(5)},${b[1].toFixed(5)}`;
}

async function runOD(od: OD): Promise<void> {
  console.log(`\n==> ${od.id}: ${od.name}`);
  const profile = PROFILE_BY_PREFERENCE[PREFERENCE] ?? "safety";
  const w = WEIGHTS[PREFERENCE] ?? WEIGHTS.comfort;

  // ---- Candidate generation (BRouter geometry-only, in parallel) ----
  type Probe = { label: string; vias: [number, number][]; alt: number };
  const probes: Probe[] = [
    { label: "idx0", vias: [], alt: 0 },
    { label: "idx1", vias: [], alt: 1 },
    { label: "idx2", vias: [], alt: 2 },
  ];

  const corridor = facilitiesInCorridor(od.from, od.to);
  if (corridor) {
    console.log(
      `    facility spine: ${corridor.spine.length} pts, ~${corridor.lengthM}m along, ` +
        `classes ${JSON.stringify(corridor.classCounts)}`
    );
    probes.push({ label: "fac-mid", vias: pickVias(corridor.spine, [0.5]), alt: 0 });
    probes.push({
      label: "fac-thirds",
      vias: pickVias(corridor.spine, [1 / 3, 2 / 3]),
      alt: 0,
    });
    probes.push({
      label: "fac-quarters",
      vias: pickVias(corridor.spine, [0.25, 0.5, 0.75]),
      alt: 0,
    });
  } else {
    console.log("    facility spine: (none in corridor)");
  }

  const settled = await Promise.allSettled(
    probes.map((p) => fetchBrouterGeometry(od.from, od.to, p.vias, profile, p.alt))
  );

  const raw: Array<{ label: string; geom: BrouterGeometry }> = [];
  const seen = new Set<string>();
  let idx0: BrouterGeometry | null = null;
  settled.forEach((s, i) => {
    const label = probes[i].label;
    if (s.status !== "fulfilled") {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.log(`    ${pad(label, 13)} ERROR: ${msg.slice(0, 70)}`);
      return;
    }
    if (label === "idx0") idx0 = s.value;
    const key = geomKey(s.value);
    if (seen.has(key)) return; // dedup identical alternatives / no-op vias
    seen.add(key);
    raw.push({ label, geom: s.value });
  });

  if (!idx0 || raw.length === 0) {
    console.log("    (no baseline route — skipping)");
    return;
  }
  const baseline: BrouterGeometry = idx0;

  // ---- Detour cap: drop candidates that ballooned (wrong-way one-way loops) ----
  const cap = Math.min(baseline.distance_m * 1.25, baseline.distance_m + 800);
  const kept = raw.filter(
    (r) => r.label === "idx0" || r.geom.distance_m <= cap
  );

  // ---- Score ----
  const shortest = Math.min(...kept.map((r) => r.geom.distance_m).filter((d) => d > 0));
  const base = Number.isFinite(shortest) && shortest > 0 ? shortest : 1;

  const candidates: Candidate[] = kept.map(({ label, geom }) => {
    const dist = geom.distance_m > 0 ? geom.distance_m : 1;
    const greenwayCov = facilityMeters(geom.coords, GREENWAY_EQUIVALENT) / dist;
    const bufferedCov = facilityMeters(geom.coords, BUFFERED) / dist;
    const facilityCov = facilityMeters(geom.coords, FACILITY) / dist;
    const detour = Math.max(0, geom.distance_m / base - 1);
    const score = w.green * greenwayCov + w.fac * facilityCov - w.dist * detour;
    return { label, geom, greenwayCov, bufferedCov, facilityCov, detour, score };
  });

  candidates.sort(
    (a, b) => b.score - a.score || b.facilityCov - a.facilityCov || a.geom.distance_m - b.geom.distance_m
  );
  const winner = candidates[0];
  const aCand = candidates.find((c) => c.label === "idx0")!;

  // ---- Report ----
  console.log(
    `    ${pad("cand", 13)} ${pad("green", 7)} ${pad("buffered", 9)} ${pad("facility", 9)} ${pad("dist", 9)} ${pad("detour", 8)} score`
  );
  for (const c of candidates) {
    const mark = c.label === winner.label ? "★" : c.label === "idx0" ? "A" : " ";
    console.log(
      `  ${mark} ${pad(c.label, 13)} ${pad(pct(c.greenwayCov), 7)} ${pad(pct(c.bufferedCov), 9)} ` +
        `${pad(pct(c.facilityCov), 9)} ${pad(km(c.geom.distance_m), 9)} ${pad(pct(c.detour), 8)} ${c.score.toFixed(3)}`
    );
  }
  const dDetour = winner.geom.distance_m / baseline.distance_m - 1;
  console.log(
    `    A=idx0  B=${winner.label}  |  buffered ${pct(aCand.bufferedCov)}→${pct(winner.bufferedCov)}  ` +
      `facility ${pct(aCand.facilityCov)}→${pct(winner.facilityCov)}  greenway ${pct(aCand.greenwayCov)}→${pct(winner.greenwayCov)}  ` +
      `detour ${pct(dDetour)}`
  );

  // ---- Dump GeoJSON (A, B, facility spine) ----
  await mkdir(RESULTS_DIR, { recursive: true });
  const feat = (
    coords: [number, number][],
    props: Record<string, unknown>
  ) => ({
    type: "Feature" as const,
    properties: props,
    geometry: { type: "LineString" as const, coordinates: coords },
  });
  const features = [
    feat(baseline.coords, { variant: "A-baseline", label: "idx0", od: od.id }),
    feat(winner.geom.coords, {
      variant: "B-facility",
      label: winner.label,
      od: od.id,
      buffered_cov: winner.bufferedCov,
      facility_cov: winner.facilityCov,
    }),
  ];
  if (corridor) {
    features.push(feat(corridor.spine, { variant: "facility-spine", od: od.id }));
  }
  await writeFile(
    resolve(RESULTS_DIR, `fac-${od.id}.geojson`),
    JSON.stringify({ type: "FeatureCollection", features }, null, 2)
  );
}

function parseLngLat(s: string | undefined): [number, number] | null {
  if (!s) return null;
  const [lng, lat] = s.split(",").map(Number);
  return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
}

async function main(): Promise<void> {
  if (PREFERENCE === "ultra") {
    console.warn(
      "[warn] preference=ultra → safety-ultra profile only exists on our brouter-service; " +
        "against brouter.de this falls back to whatever profile the server has. Use comfort for brouter.de."
    );
  }

  const odFrom = parseLngLat(process.env.OD_FROM);
  const odTo = parseLngLat(process.env.OD_TO);

  let ods: OD[];
  if (odFrom && odTo) {
    ods = [
      {
        id: process.env.OD_ID ?? "custom",
        name: process.env.OD_NAME ?? "Custom OD",
        from: odFrom,
        to: odTo,
      },
    ];
  } else {
    const canonical: CanonicalRoute[] = JSON.parse(
      await readFile(CANONICAL_PATH, "utf8")
    );
    ods = [
      {
        // Headline: SE 17th corridor — built buffered lane BRouter avoids.
        id: "00-se17th",
        name: "SE 17th corridor (Brooklyn): N of Pershing → S of Insley",
        from: [-122.6452, 45.5012],
        to: [-122.6498, 45.4822],
      },
      ...canonical.map((c) => ({
        id: c.id,
        name: c.name,
        from: [c.from.lng, c.from.lat] as [number, number],
        to: [c.to.lng, c.to.lat] as [number, number],
      })),
    ];
  }

  console.log("BikeRouteNicePDX — PBOT facility-steering prototype");
  console.log(`preference: ${PREFERENCE} (profile ${PROFILE_BY_PREFERENCE[PREFERENCE] ?? "safety"})`);
  console.log(`BROUTER_URL: ${process.env.BROUTER_URL ?? "(config default)"}`);
  console.log(`ODs: ${ods.length}  (results → tests/results/fac-<od>.geojson)`);

  for (const od of ods) {
    try {
      await runOD(od);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`    FATAL on ${od.id}: ${msg.slice(0, 120)}`);
    }
  }
  console.log(
    `\nTip: open tests/results/fac-00-se17th.geojson on geojson.io — B-facility should ride SE 17th.`
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
