/**
 * instructions.ts — turn phrasing for display + voice.
 *
 * One source of truth for how a maneuver is worded, used by BOTH step
 * producers (Valhalla trace_route enrichment and the geometry-synthesized
 * fallback in brouter.ts). Each RouteStep carries:
 *   - `instruction`  — display text ("Turn left onto SE Ankeny St")
 *   - `spoken`       — TTS-ready clause, lowercase-first so clients can prefix
 *                      "In 300 feet, …" ("turn left onto Southeast Ankeny Street")
 *
 * Bike-network street names arrive ALL-CAPS abbreviated ("SE 122ND AVE");
 * displayStreetName() renders them for the HUD and expandStreetName() spells
 * them out for speech.
 *
 * TODO v1.1: wayfinding-sign substitution ("Follow signs to <destination>")
 * and Portland-specific named crossings ("the Esplanade", "Steel Bridge").
 */

const DIRECTIONS: Record<string, string> = {
  N: "North",
  NE: "Northeast",
  E: "East",
  SE: "Southeast",
  S: "South",
  SW: "Southwest",
  W: "West",
  NW: "Northwest",
};

const SUFFIXES: Record<string, string> = {
  AVE: "Avenue",
  BLVD: "Boulevard",
  BR: "Bridge",
  CIR: "Circle",
  CT: "Court",
  DR: "Drive",
  EXPY: "Expressway",
  FWY: "Freeway",
  HWY: "Highway",
  LN: "Lane",
  LOOP: "Loop",
  PKWY: "Parkway",
  PL: "Place",
  RD: "Road",
  SQ: "Square",
  ST: "Street",
  TER: "Terrace",
  TRL: "Trail",
  WAY: "Way",
};

/** "122ND" → "122nd"; returns null when the token isn't an ordinal. */
function ordinal(token: string): string | null {
  const m = /^(\d+)(ST|ND|RD|TH)$/i.exec(token);
  return m ? `${m[1]}${m[2].toLowerCase()}` : null;
}

function titleCase(token: string): string {
  if (token.length === 0) return token;
  return token[0].toUpperCase() + token.slice(1).toLowerCase();
}

/** True when a token is ALL-CAPS (the bike-network export style). */
function isShouting(token: string): boolean {
  return token === token.toUpperCase() && /[A-Z]/.test(token);
}

/**
 * HUD form: "SE 122ND AVE" → "SE 122nd Ave". Directionals stay abbreviated,
 * suffixes become title-cased abbreviations, everything else title-cases.
 * Mixed-case input (already formatted, e.g. from Valhalla) passes through.
 */
export function displayStreetName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((tok) => {
      if (!isShouting(tok)) return tok;
      if (DIRECTIONS[tok]) return tok;
      const ord = ordinal(tok);
      if (ord) return ord;
      if (SUFFIXES[tok]) return titleCase(tok);
      if (tok.length === 1) return tok; // single-letter street (N "B" Ave)
      return titleCase(tok);
    })
    .join(" ");
}

/**
 * Speech form: "SE 122ND AVE" → "Southeast 122nd Avenue". Also expands
 * abbreviated directionals/suffixes in mixed-case input ("SE Ankeny St").
 */
export function expandStreetName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((tok) => {
      const upper = tok.toUpperCase();
      if (DIRECTIONS[upper]) return DIRECTIONS[upper];
      if (SUFFIXES[upper]) return SUFFIXES[upper];
      const ord = ordinal(tok);
      if (ord) return ord;
      return isShouting(tok) && tok.length > 1 ? titleCase(tok) : tok;
    })
    .join(" ");
}

/** Display verb for a maneuver tag; null for tags with no turn wording. */
function turnVerb(maneuverType: string): string | null {
  switch (maneuverType) {
    case "left":
    case "exit_left":
      return "Turn left";
    case "right":
    case "exit_right":
      return "Turn right";
    case "slight_left":
    case "stay_left":
    case "ramp_left":
      return "Bear left";
    case "slight_right":
    case "stay_right":
    case "ramp_right":
      return "Bear right";
    case "sharp_left":
      return "Turn sharply left";
    case "sharp_right":
      return "Turn sharply right";
    case "u_turn_left":
    case "u_turn_right":
      return "Make a U-turn";
    case "continue":
    case "becomes":
    case "stay_straight":
    case "ramp_straight":
      return "Continue";
    case "merge":
    case "merge_left":
    case "merge_right":
      return "Merge";
    case "roundabout_enter":
      return "Enter the roundabout";
    case "roundabout_exit":
      return "Exit the roundabout";
    default:
      return null;
  }
}

/**
 * Display instruction: "Turn left onto SE Ankeny St", "Bear right", …
 * `streetName` is raw (any case); `cls` lets unnamed off-street turns read
 * "onto the path" instead of a bare "Turn left".
 */
export function composeInstruction(
  maneuverType: string,
  streetName: string | null,
  cls: string | null
): string {
  const verb = turnVerb(maneuverType) ?? "Continue";
  if (streetName) {
    const onto = verb === "Continue" || verb === "Merge" ? "on" : "onto";
    return `${verb} ${onto} ${displayStreetName(streetName)}`;
  }
  if (cls === "off_street" && verb !== "Continue") return `${verb} onto the path`;
  return verb;
}

/**
 * TTS clause, lowercase-first: "turn left onto Southeast Ankeny Street".
 * Clients prefix distance ("In 300 feet, …") or chain ("…, then immediately …").
 */
export function spokenClause(
  maneuverType: string,
  streetName: string | null,
  cls: string | null
): string {
  if (maneuverType.startsWith("start")) {
    return streetName ? `head out on ${expandStreetName(streetName)}` : "head out";
  }
  if (maneuverType.startsWith("destination")) return "arrive at your destination";
  const text = composeInstruction(maneuverType, streetName, cls);
  const spoken = streetName
    ? text.replace(displayStreetName(streetName), expandStreetName(streetName))
    : text;
  return spoken.charAt(0).toLowerCase() + spoken.slice(1);
}
