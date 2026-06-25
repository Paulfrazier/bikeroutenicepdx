/**
 * check-contraflow.ts — guard against the OSM-gap backlog re-introducing bogus
 * contraflow (oneway:bicycle=no) tags that route bikes the WRONG WAY.
 *
 * Background (2026-06-24 bug): the contraflow pass in build-osm-backlog.ts once
 * grouped OSM ways by street NAME and, if any same-named segment asserted
 * oneway:bicycle=no, stamped the tag onto EVERY same-named oneway=yes facility
 * segment. Three stray assertions on one-way N Williams flagged 44 northbound
 * segments, so the self-built BRouter tiles let bikes ride south down Williams
 * (286 bogus flags across 27 one-way arterials). The fix only flags a genuine
 * ENCLOSED HOLE — both endpoints touch a oneway:bicycle=no segment of the SAME
 * street name. This check fails the build if that invariant regresses.
 *
 * Two layers:
 *   1. CI-safe backstop (always runs, reads only the committed backlog CSV):
 *      - contraflow count must stay under CAP (a name-propagation regression
 *        explodes it back to the hundreds), and
 *      - no contraflow entry may sit on a known one-way arterial that must never
 *        carry a southbound/contraflow bike tag (DENYLIST).
 *   2. Principled re-validation (runs only when the gitignored reconciliation
 *      geojson is present locally): re-derives the enclosed-same-name rule per
 *      entry and fails on any flag that isn't a real enclosed hole.
 *
 * USAGE:  tsx scripts/check-contraflow.ts   (or: npm run check)
 * EXIT:   0 backlog contraflow is sound · 1 a bogus/over-propagated flag exists
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CSV = path.join(REPO_ROOT, "data", "backlog", "osm-gaps.csv");
const RECON_GEOJSON = path.join(REPO_ROOT, "data", "reconciled", "current", "osm-ways.geojson");

/** Hard cap on contraflow entries. Genuine enclosed holes are rare (1 as of the
 *  fix); the name-propagation bug produced 286. Anything near triple digits is a
 *  regression, not real two-way cycletrack holes. */
const CONTRAFLOW_CAP = 15;

/** One-way arterials that must NEVER carry a contraflow bike tag — bikes go the
 *  wrong way if they do. These are the streets the name-propagation bug hit; N
 *  Williams is the canonical case (one-way NB; southbound bikes use Vancouver). */
const DENYLIST = new Set<string>([
  "North Williams Avenue",
  "Southwest Broadway",
  "Northeast Weidler Street",
  "Southeast Washington Street",
  "Hawthorne Bridge",
  "Northeast Couch Street",
  "Southeast Morrison Street",
]);

// ---------------------------------------------------------------------------
// Layer 1 — CI-safe backstop (committed CSV only)
// ---------------------------------------------------------------------------
interface CfEntry { id: string; name: string }

function parseContraflow(): CfEntry[] {
  if (!fs.existsSync(CSV)) {
    console.error(`✗ contraflow check: backlog CSV missing at ${path.relative(REPO_ROOT, CSV)}`);
    process.exit(1);
  }
  const lines = fs.readFileSync(CSV, "utf8").split(/\r?\n/).filter(Boolean);
  // header: gap,osm_way_id,name,pbot_class,suggested_tags,length_m,lat,lng
  const out: CfEntry[] = [];
  for (const line of lines.slice(1)) {
    // name is quoted (may contain commas); a light CSV split that respects quotes.
    const cols = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((c) =>
      c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'),
    ) ?? [];
    if (cols[0] !== "contraflow") continue;
    out.push({ id: cols[1], name: cols[2] });
  }
  return out;
}

const entries = parseContraflow();
const errors: string[] = [];

if (entries.length > CONTRAFLOW_CAP) {
  errors.push(
    `${entries.length} contraflow entries exceeds cap ${CONTRAFLOW_CAP} — likely a name-` +
      `propagation regression in build-osm-backlog.ts (the bug produced 286).`,
  );
}
for (const e of entries) {
  if (DENYLIST.has(e.name)) {
    errors.push(
      `contraflow flag on one-way arterial "${e.name}" (way ${e.id}) — this routes bikes ` +
        `the wrong way. Such streets must never carry oneway:bicycle=no.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Layer 2 — principled re-validation (only when reconciliation data is present)
// ---------------------------------------------------------------------------
function isOnewayBike(p: Record<string, unknown>): boolean {
  return String(p["oneway:bicycle"] ?? "") === "no";
}
const nodeKey = (c: [number, number]): string => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

let validated = 0;
if (fs.existsSync(RECON_GEOJSON)) {
  const osm = JSON.parse(fs.readFileSync(RECON_GEOJSON, "utf8")) as {
    features: { properties: Record<string, unknown> | null; geometry: { type: string; coordinates: [number, number][] } | null }[];
  };
  const byId = new Map<string, (typeof osm.features)[number]>();
  const assertNodes = new Map<string, Set<string>>();
  for (const f of osm.features) {
    const p = f.properties ?? {};
    const id = String(p["@id"] ?? "");
    if (id) byId.set(id, f);
    if (!isOnewayBike(p) || !f.geometry || f.geometry.type !== "LineString") continue;
    const cs = f.geometry.coordinates;
    if (cs.length < 2) continue;
    for (const end of [cs[0], cs[cs.length - 1]]) {
      const k = nodeKey(end);
      (assertNodes.get(k) ?? assertNodes.set(k, new Set<string>()).get(k)!).add(id);
    }
  }
  const sameNameAssertAt = (c: [number, number], id: string, name: string): boolean => {
    const ids = assertNodes.get(nodeKey(c));
    if (!ids) return false;
    for (const x of ids) {
      if (x === id) continue;
      if (String((byId.get(x)?.properties ?? {})["name"] ?? "") === name) return true;
    }
    return false;
  };
  for (const e of entries) {
    const f = byId.get(e.id);
    if (!f?.geometry || f.geometry.type !== "LineString") {
      errors.push(`contraflow way ${e.id} ("${e.name}") not found as a LineString in reconciliation`);
      continue;
    }
    const cs = f.geometry.coordinates;
    const enclosed =
      sameNameAssertAt(cs[0], e.id, e.name) && sameNameAssertAt(cs[cs.length - 1], e.id, e.name);
    if (!enclosed) {
      errors.push(
        `contraflow way ${e.id} ("${e.name}") is NOT an enclosed same-name hole — both ` +
          `endpoints must touch a oneway:bicycle=no segment of the same street.`,
      );
    } else {
      validated++;
    }
  }
}

if (errors.length) {
  console.error("✗ contraflow backlog check FAILED:\n");
  for (const e of errors) console.error(`   ${e}`);
  console.error(`\n   → re-run \`npx tsx scripts/build-osm-backlog.ts\` after fixing the contraflow rule.`);
  process.exit(1);
}

const detail = fs.existsSync(RECON_GEOJSON)
  ? `${entries.length} entries, all ${validated} re-validated as enclosed same-name holes`
  : `${entries.length} entries within cap ${CONTRAFLOW_CAP}, none on a one-way denylist (reconciliation data absent — skipped deep re-validation)`;
console.log(`✓ contraflow backlog sound (${detail})`);
