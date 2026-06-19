/**
 * Maps a Valhalla maneuver to a spoken phrase for voice navigation.
 *
 * v0.1 stub — passes through Valhalla's own instruction string.
 *
 * TODO v1.0:
 *   - Detect wayfinding signs within 30m of the maneuver point and substitute
 *     "Follow signs to <destination>" for the generated instruction.
 *   - Localize phrasing for Portland-specific street naming ("The Esplanade",
 *     "Steel Bridge", named crossings).
 *   - Compress instructions for quiet residential stretches ("Continue 0.4 mi on
 *     NE Going St" → combine consecutive continue maneuvers).
 */

export interface ValhallaManeuver {
  type: number;
  instruction: string;
  street_names?: string[];
  length: number;
  time: number;
  begin_shape_index: number;
  end_shape_index: number;
}

export function maneuverToSpoken(maneuver: ValhallaManeuver): string {
  // TODO v1.0: substitute "Follow signs to <destination>" when wayfinding sign within 30m
  return maneuver.instruction;
}
