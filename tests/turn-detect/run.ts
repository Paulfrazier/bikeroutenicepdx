/**
 * turn-detect + instruction phrasing fixture tests (offline, no live services).
 *
 * Usage: npm run test:turns   (runs: tsx tests/turn-detect/run.ts)
 *
 * Covers the Valhalla-down fallback path: geometry turn detection
 * (server/src/services/turn-detect.ts), street-name recovery from the PBOT
 * bike-network index (nearestWayName), and display/spoken phrasing
 * (server/src/voice/instructions.ts). Synthetic geometries have exact known
 * answers; the name-lookup cases use the real bike-network.geojson.
 */

import { detectTurns, bearingDeg } from "../../server/src/services/turn-detect.js";
import { nearestWayName } from "../../server/src/services/greenway-coverage.js";
import {
  displayStreetName,
  expandStreetName,
  composeInstruction,
  spokenClause,
} from "../../server/src/voice/instructions.js";

let failures = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✘ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Synthetic geometry builders (local-meter walking from a Portland origin)
// ---------------------------------------------------------------------------

const ORIGIN: [number, number] = [-122.65, 45.52];
const M_PER_DEG_LAT = 111_320;

function walk(
  from: [number, number],
  headingDeg: number,
  meters: number
): [number, number] {
  const rad = (headingDeg * Math.PI) / 180;
  const dNorth = Math.cos(rad) * meters;
  const dEast = Math.sin(rad) * meters;
  const lat = from[1] + dNorth / M_PER_DEG_LAT;
  const lng = from[0] + dEast / (M_PER_DEG_LAT * Math.cos((from[1] * Math.PI) / 180));
  return [lng, lat];
}

/** Polyline from legs of (heading, length, vertex spacing). */
function path(
  legs: Array<{ heading: number; length: number; step?: number }>
): [number, number][] {
  const coords: [number, number][] = [ORIGIN];
  let cur = ORIGIN;
  for (const leg of legs) {
    const step = leg.step ?? 5;
    let walked = 0;
    while (walked < leg.length) {
      const d = Math.min(step, leg.length - walked);
      cur = walk(cur, leg.heading, d);
      coords.push(cur);
      walked += d;
    }
  }
  return coords;
}

/** Smooth arc: turns `totalDeg` over `length` meters in small increments. */
function arcPath(startHeading: number, totalDeg: number, length: number): [number, number][] {
  const coords: [number, number][] = [ORIGIN];
  let cur = ORIGIN;
  const n = Math.ceil(length / 5);
  for (let i = 0; i < n; i++) {
    const heading = startHeading + (totalDeg * (i + 0.5)) / n;
    cur = walk(cur, heading, length / n);
    coords.push(cur);
  }
  return coords;
}

// ---------------------------------------------------------------------------
// detectTurns
// ---------------------------------------------------------------------------

console.log("detectTurns:");
{
  const straight = path([{ heading: 0, length: 300 }]);
  check("straight line → no turns", detectTurns(straight).length === 0);
}
{
  const ell = path([
    { heading: 0, length: 200 },
    { heading: 90, length: 200 },
  ]);
  const turns = detectTurns(ell);
  check(
    "L-shape → exactly one right",
    turns.length === 1 && turns[0].maneuver_type === "right",
    JSON.stringify(turns.map((t) => t.maneuver_type))
  );
}
{
  const leftEll = path([
    { heading: 0, length: 150 },
    { heading: 270, length: 150 },
  ]);
  const turns = detectTurns(leftEll);
  check(
    "left L-shape → exactly one left",
    turns.length === 1 && turns[0].maneuver_type === "left",
    JSON.stringify(turns.map((t) => t.maneuver_type))
  );
}
{
  // 90° corner drawn dense (vertex every 2 m) — one turn, not a spray.
  const dense = path([
    { heading: 0, length: 100, step: 2 },
    { heading: 90, length: 100, step: 2 },
  ]);
  const turns = detectTurns(dense);
  check(
    "dense-vertex corner → one merged right",
    turns.length === 1 && turns[0].maneuver_type === "right",
    JSON.stringify(turns.map((t) => t.maneuver_type))
  );
}
{
  // Zigzag: right then left, 60 m apart — both survive.
  const zig = path([
    { heading: 0, length: 120 },
    { heading: 90, length: 60 },
    { heading: 0, length: 120 },
  ]);
  const turns = detectTurns(zig);
  check(
    "zigzag → right then left",
    turns.length === 2 && turns[0].maneuver_type === "right" && turns[1].maneuver_type === "left",
    JSON.stringify(turns.map((t) => t.maneuver_type))
  );
}
{
  // Gentle 90° road curve over 400 m — NOT a turn.
  const curve = arcPath(0, 90, 400);
  check(
    "gentle 90° curve over 400 m → no turns",
    detectTurns(curve).length === 0,
    JSON.stringify(detectTurns(curve).map((t) => t.maneuver_type))
  );
}
{
  // 40° jog → slight.
  const slight = path([
    { heading: 0, length: 150 },
    { heading: 40, length: 150 },
  ]);
  const turns = detectTurns(slight);
  check(
    "40° jog → one slight_right",
    turns.length === 1 && turns[0].maneuver_type === "slight_right",
    JSON.stringify(turns.map((t) => t.maneuver_type))
  );
}
{
  // Sharp 140° hairpin.
  const sharp = path([
    { heading: 0, length: 150 },
    { heading: 140, length: 150 },
  ]);
  const turns = detectTurns(sharp);
  check(
    "140° hairpin → one sharp_right",
    turns.length === 1 && turns[0].maneuver_type === "sharp_right",
    JSON.stringify(turns.map((t) => t.maneuver_type))
  );
}

// ---------------------------------------------------------------------------
// bearingDeg sanity
// ---------------------------------------------------------------------------

console.log("bearingDeg:");
{
  const north = bearingDeg(ORIGIN, walk(ORIGIN, 0, 100));
  const east = bearingDeg(ORIGIN, walk(ORIGIN, 90, 100));
  check("north ≈ 0°", Math.abs(north) < 1 || Math.abs(north - 360) < 1, String(north));
  check("east ≈ 90°", Math.abs(east - 90) < 1, String(east));
}

// ---------------------------------------------------------------------------
// Street-name phrasing
// ---------------------------------------------------------------------------

console.log("instructions:");
check(
  'display "SE 122ND AVE" → "SE 122nd Ave"',
  displayStreetName("SE 122ND AVE") === "SE 122nd Ave",
  displayStreetName("SE 122ND AVE")
);
check(
  'expand "SE 122ND AVE" → "Southeast 122nd Avenue"',
  expandStreetName("SE 122ND AVE") === "Southeast 122nd Avenue",
  expandStreetName("SE 122ND AVE")
);
check(
  'expand mixed-case "SE Ankeny St" → "Southeast Ankeny Street"',
  expandStreetName("SE Ankeny St") === "Southeast Ankeny Street",
  expandStreetName("SE Ankeny St")
);
check(
  'compose left + "NE GOING ST" → "Turn left onto NE Going St"',
  composeInstruction("left", "NE GOING ST", null) === "Turn left onto NE Going St",
  composeInstruction("left", "NE GOING ST", null)
);
check(
  'spoken left + "NE GOING ST" → "turn left onto Northeast Going Street"',
  spokenClause("left", "NE GOING ST", null) === "turn left onto Northeast Going Street",
  spokenClause("left", "NE GOING ST", null)
);
check(
  "spoken unnamed off-street → path phrasing",
  spokenClause("slight_right", null, "off_street") === "bear right onto the path",
  spokenClause("slight_right", null, "off_street")
);
check(
  "spoken destination",
  spokenClause("destination", null, null) === "arrive at your destination",
  spokenClause("destination", null, null)
);

// ---------------------------------------------------------------------------
// nearestWayName against the real bike network (loaded lazily by the service)
// ---------------------------------------------------------------------------

console.log("nearestWayName (real network):");
{
  // SE Ankeny greenway near SE 28th — a stable, well-known named greenway.
  const pt: [number, number] = [-122.6367, 45.5223];
  const along = nearestWayName(pt[0], pt[1], 90); // Ankeny runs east-west
  check(
    "point on SE Ankeny with east bearing → ANKENY",
    (along ?? "").toUpperCase().includes("ANKENY"),
    String(along)
  );
  const across = nearestWayName(pt[0], pt[1], 0); // perpendicular bearing
  check(
    "same point with north bearing → not ANKENY (cross-street guard)",
    !(across ?? "").toUpperCase().includes("ANKENY"),
    String(across)
  );
}

// ---------------------------------------------------------------------------

if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\n✓ all turn-detect fixtures pass");
