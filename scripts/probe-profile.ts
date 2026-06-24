/**
 * probe-profile.ts — THROWAWAY: A/B two BRouter profiles on idx0 routes.
 *
 * Routes each OD's baseline (alternativeidx=0, no vias) under a given BRouter
 * profile and reports greenway / buffered / facility coverage. Used to validate
 * the Phase-0 safety-ultra magnet tweak by comparing the OLD vs NEW profile id
 * (both uploaded to brouter.de, which serves the same rd5 our prod downloads).
 *
 *   BROUTER_URL=https://brouter.de BROUTER_PROFILE=custom_123 npx tsx scripts/probe-profile.ts
 */
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchBrouterGeometry } from "../server/src/services/brouter.js";
import { facilityMeters, GREENWAY_EQUIVALENT, type NetworkClass } from "../server/src/services/greenway-coverage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CANON = resolve(__dirname, "../tests/routes/canonical.json");
const PROFILE = process.env.BROUTER_PROFILE ?? "safety-ultra";
const BUFFERED = new Set<NetworkClass>(["buffered"]);
const FACILITY = new Set<NetworkClass>(["buffered", "protected"]);
const pct = (r: number) => (Math.round(r * 1000) / 10).toFixed(1) + "%";
const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));

async function main() {
  const canon = JSON.parse(await readFile(CANON, "utf8")) as Array<{ id: string; from: { lng: number; lat: number }; to: { lng: number; lat: number } }>;
  const ods: Array<{ id: string; from: [number, number]; to: [number, number] }> = [
    { id: "se17th-haw-sell", from: [-122.647, 45.512], to: [-122.647, 45.466] },
    ...canon.map((c) => ({ id: c.id, from: [c.from.lng, c.from.lat] as [number, number], to: [c.to.lng, c.to.lat] as [number, number] })),
  ];
  console.log(`profile=${PROFILE}  url=${process.env.BROUTER_URL}`);
  console.log(`${pad("od", 18)} ${pad("greenway", 9)} ${pad("buffered", 9)} ${pad("facility", 9)} dist`);
  for (const od of ods) {
    try {
      const g = await fetchBrouterGeometry(od.from, od.to, [], PROFILE, 0);
      const d = g.distance_m || 1;
      console.log(
        `${pad(od.id, 18)} ${pad(pct(facilityMeters(g.coords, GREENWAY_EQUIVALENT) / d), 9)} ` +
          `${pad(pct(facilityMeters(g.coords, BUFFERED) / d), 9)} ${pad(pct(facilityMeters(g.coords, FACILITY) / d), 9)} ${(g.distance_m / 1000).toFixed(2)}km`
      );
    } catch (e) {
      console.log(`${pad(od.id, 18)} ERROR ${(e instanceof Error ? e.message : String(e)).slice(0, 60)}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
