/**
 * jurisdictions.ts
 *
 * The registry of bike-facility data sources, one entry per publishing agency.
 *
 * WHY THIS EXISTS
 * Until the metro expansion, `export-bike-network.ts` had two hardcoded City of
 * Portland ArcGIS URLs and one `CLASS_MAP` keyed to PBOT facility codes. Every
 * agency codes facilities differently — PBOT says `NG`, Metro says `BKE-BLVD`,
 * Clark County says `2` — so adding a jurisdiction meant editing the exporter.
 * The per-jurisdiction `classMap` is the whole point of this abstraction: each
 * agency's vocabulary is normalized into the SAME `DisplayClass` set, so every
 * downstream consumer (web/src/friendliness.ts, server greenway-coverage.ts,
 * iOS BikeFriendliness.swift, scripts/build-graph.ts) keeps working unchanged.
 *
 * PRECEDENCE
 * Sources overlap geographically. `clipOutsideOf` names a boundary that a
 * jurisdiction's features must fall OUTSIDE of, which is how PBOT keeps winning
 * inside Portland city limits: PBOT's layer is fresher and more granular than
 * RLIS, and `data/pbot-supplement/new-builds.geojson` carries 2024–26 lanes that
 * RLIS does not know about yet. Without the clip, staler regional geometry would
 * sit on top of the supplement work and silently down-class it.
 */

/** Normalized display category — drives color on every surface. Do not extend
 * without updating web ROUTE_CLASS_COLORS + iOS MKPolyline+Kind.swift together
 * (scripts/check-parity.ts enforces the pair). */
export type DisplayClass =
  | "greenway"
  | "path"
  | "protected"
  | "buffered"
  | "lane"
  | "shared"
  | "calm" // shared roadway, low traffic (just below greenway)
  | "calm_mod"; // shared roadway, moderate traffic (below buffered)

/** Traffic-stress rating, normalized from an agency's own stress field.
 * Currently only RLIS publishes one (`BIKETHERE`). Consumed by the rclass bake
 * as a fallback where the PBOT speed/lane joins have no coverage. */
export type StressClass = "low" | "moderate" | "high" | "caution";

export interface SourceSpec {
  /** Progress-log label. */
  label: string;
  /** ArcGIS MapServer/FeatureServer LAYER url (no trailing /query). */
  url: string;
  where: string;
  /** Comma-separated outFields. Must include codeField + nameField + stressField. */
  fields: string;
  /** Keep under the layer's maxRecordCount. */
  pageSize: number;
  /** Attribute holding the agency's facility code. */
  codeField: string;
  /** Attribute holding the street name, if the layer has one. */
  nameField?: string;
  /** Agency facility code → our DisplayClass. Codes absent here are dropped. */
  classMap: Record<string, DisplayClass>;
  /** Attribute holding a traffic-stress rating, if published. */
  stressField?: string;
  /** Agency stress code → our StressClass. */
  stressMap?: Record<string, StressClass>;
}

export interface Jurisdiction {
  /** Stable id — used in output filenames and the manifest. */
  id: string;
  label: string;
  /** Rendered verbatim in the app credits. Some licenses require exact wording. */
  attribution: string;
  attributionUrl: string;
  sources: SourceSpec[];
  /**
   * Drop features falling inside this boundary. `"portland"` fetches the City
   * Boundaries polygon for Portland (see lib/boundary.ts). Undefined = keep all.
   */
  clipOutsideOf?: "portland";
}

// ---------------------------------------------------------------------------
// City of Portland — PBOT. The original two sources, unchanged.
// ---------------------------------------------------------------------------

const PBOT_CLASS_MAP: Record<string, DisplayClass> = {
  NG: "greenway", // Neighborhood Greenway
  TRL: "path", // Off-Street Paths/Trails
  PBL: "protected", // Protected Bike Lane
  SIR: "protected", // Separated in-Roadway
  BBL: "buffered", // Buffered Bike Lane
  BBBL: "buffered", // Buffered variants
  SBBL: "buffered",
  BL: "lane", // Bike Lane
  ABL: "lane", // Advisory Bike Lane
  ESR: "shared", // Enhanced Shared Roadway
};

export const PORTLAND: Jurisdiction = {
  id: "portland",
  label: "City of Portland (PBOT)",
  attribution: "PBOT",
  attributionUrl: "https://www.portland.gov/transportation",
  sources: [
    {
      label: "pbot-facilities",
      url: "https://www.portlandmaps.com/od/rest/services/COP_OpenData_Transportation/MapServer/75",
      where: "Status='ACTIVE'",
      fields: "Facility,SegmentName,SCS",
      pageSize: 200, // layer maxRecordCount
      codeField: "Facility",
      nameField: "SegmentName",
      classMap: PBOT_CLASS_MAP,
    },
    {
      // Recommended quiet streets with NO built facility, so they're absent from
      // the facility inventory above — purely additive. Everything else in this
      // layer (NG/BL/BBL/MUP) is ignored because source 1 carries it with
      // authoritative facility codes.
      label: "pbot-shared",
      url: "https://www.portlandmaps.com/arcgis/rest/services/Public/PBOT_RecommendedBicycleRoutes/MapServer/4",
      where: "ConnectionType IN ('SR_LT','SR_MT')",
      fields: "ConnectionType,StreetName",
      pageSize: 1000, // maxRecordCount is 2000; stay well under
      codeField: "ConnectionType",
      nameField: "StreetName",
      classMap: {
        SR_LT: "calm", // Shared Roadway, Low Traffic
        SR_MT: "calm_mod", // Shared Roadway, Moderate Traffic
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// Metro RLIS — the whole Oregon metro in one layer.
//
// 30k+ bike-typed segments spanning Multnomah, Washington and Clackamas
// counties: Beaverton, Hillsboro, Tigard, Tualatin, Lake Oswego, Gresham,
// Milwaukie, Oregon City, Sherwood, Wilsonville and the unincorporated areas.
// Stops at the Columbia — Vancouver WA is a separate jurisdiction.
//
// LICENSE: free and keyless, but NOT public domain. Metro's Limited Use License
// requires the attribution string below plus the date the data was received to
// be displayed on derivative products, and forbids implying Metro endorsement.
// The fetch date is recorded in the manifest (`fetchedAt`) and rendered by the
// clients — do not hardcode it in UI copy, it goes stale on every re-export.
// ---------------------------------------------------------------------------

export const RLIS: Jurisdiction = {
  id: "rlis",
  label: "Metro RLIS regional bike network",
  attribution: "© Oregon Metro",
  attributionUrl: "https://www.oregonmetro.gov/rlis",
  clipOutsideOf: "portland",
  sources: [
    {
      label: "rlis-bike-routes",
      url: "https://gis.oregonmetro.gov/arcgis/rest/services/OpenData/TransitDataWebMerc/MapServer/1",
      // OTH-CONN / OTH-XING / OTH-SWLK are connectors, crossings and sidewalks
      // (199 features total) — not ridable facilities. Excluded by omission from
      // classMap, but filtered server-side too so we don't page through them.
      where: "BIKETYP IS NOT NULL AND BIKETYP NOT IN ('OTH-CONN','OTH-XING','OTH-SWLK')",
      fields: "NAME,BIKETYP,BIKETHERE",
      pageSize: 1000, // layer maxRecordCount
      codeField: "BIKETYP",
      nameField: "NAME",
      classMap: {
        "BKE-BLVD": "greenway", // Bike boulevard == neighborhood greenway
        "BKE-TRAK": "protected", // Cycle track
        "BKE-BUFF": "buffered", // Buffered bike lane
        "BKE-LANE": "lane", // Standard bike lane
        "BKE-SHRD": "shared", // Shared roadway markings (sharrow)
        "SHL-WIDE": "shared", // Wide shoulder — ridable, no dedicated space
        "PTH-REMU": "path", // Regional multi-use path
        "PTH-LOMU": "path", // Local multi-use path
      },
      stressField: "BIKETHERE",
      stressMap: {
        LT: "low",
        MT: "moderate",
        HT: "high",
        CA: "caution",
      },
    },
  ],
};

/**
 * Phase 1 jurisdictions, in precedence order (earlier wins on overlap — enforced
 * by `clipOutsideOf` rather than merge order, but keep PBOT first for clarity).
 *
 * Phase 2 adds Vancouver WA (`COV_TransBSMnetwork/0`, filter `Existing=1`, its
 * `ExistBikeF` already uses PBL/BBL/BL/MUP/SR so it needs no remapping) and
 * Clark County (`BikeRoutes/0`, numeric `RouteType`, exclude 6=planned and treat
 * 9=cyclists-prohibited as a routing barrier). RLIS returns nothing north of the
 * Columbia, so there is no overlap to resolve there.
 */
export const JURISDICTIONS: Jurisdiction[] = [PORTLAND, RLIS];
