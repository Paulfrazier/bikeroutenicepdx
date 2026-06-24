/**
 * build-osm-backlog.ts — generate a verified-edit worklist of OSM bike-data gaps.
 *
 * Every routing problem we've traced is an OSM DATA gap, not a PBOT one. This
 * turns the PBOT↔OSM reconciliation into an actionable backlog that feeds BOTH:
 *   (a) the self-built BRouter tiles (as an osmChange patch), and
 *   (b) upstream OSM edits / a MapRoulette challenge (community).
 *
 * Two gap classes:
 *   PRESENCE  — an OSM way that PBOT classifies as a built facility but which has
 *               NO OSM bike tag (cycleway / bicycle=designated / lcn). The router
 *               sees a plain road. (~2,359 citywide; 40% of SE 17th.)
 *   CONTRAFLOW— a `oneway=yes` segment on a street that ELSEWHERE declares
 *               `oneway:bicycle=no` (a two-way cycletrack) but is itself missing
 *               that tag, so the router refuses contraflow. (SE 16th pattern.)
 *               High-precision: only flags streets that already assert contraflow.
 *
 * READS:  data/reconciled/current/way-tags.json   (PBOT class per OSM way id)
 *         data/reconciled/current/osm-ways.geojson (OSM tags + geometry)
 * WRITES: data/backlog/osm-gaps.geojson            (one Feature per gap)
 *         data/backlog/osm-gaps.csv                (flat worklist)
 *         data/backlog/maproulette.geojson         (newline-delimited tasks)
 *         data/backlog/summary.json                (counts + SE 17th breakdown)
 *
 * USAGE:  NODE_OPTIONS=--max-old-space-size=4096 npx tsx scripts/build-osm-backlog.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RECON = path.join(REPO, "data", "reconciled", "current");
const OUT = path.join(REPO, "data", "backlog");

type PbotClass = "off_street" | "greenway" | "protected" | "buffered" | "standard";

/** PBOT class → suggested OSM tags (mirrors build-graph.ts CLASS_TAGS). A
 *  STARTING POINT for human verification, not a blind apply. */
const SUGGESTED_TAGS: Record<PbotClass, Record<string, string>> = {
  off_street: { cycleway: "track", bicycle: "designated", lcn: "yes" },
  greenway: { cycleway: "track", bicycle: "designated", lcn: "yes" },
  protected: { cycleway: "track", bicycle: "designated" },
  buffered: { cycleway: "lane" },
  standard: { cycleway: "lane" },
};

interface WayTag {
  bicycle_network_class: PbotClass;
  name: string | null;
  centroid_lng: number;
  centroid_lat: number;
  length_m: number;
}

interface OsmFeature {
  properties: Record<string, unknown> | null;
  geometry: { type: string; coordinates: [number, number][] } | null;
}

/** Does this OSM way already carry any bike hint the router would see? */
function hasBikeTag(p: Record<string, unknown>): boolean {
  for (const k of Object.keys(p)) {
    if (k === "cycleway" || k.startsWith("cycleway:")) {
      const v = String(p[k] ?? "");
      if (v && v !== "no" && v !== "none") return true;
    }
  }
  const bi = String(p["bicycle"] ?? "");
  if (bi === "designated" || bi === "yes" || bi === "permissive") return true;
  if (String(p["lcn"] ?? "") === "yes") return true;
  return false;
}

function isOnewayBike(p: Record<string, unknown>): boolean {
  return String(p["oneway:bicycle"] ?? "") === "no";
}
function hasCyclewayFacility(p: Record<string, unknown>): boolean {
  for (const k of Object.keys(p)) {
    if ((k === "cycleway" || k.startsWith("cycleway:")) && /lane|track|shared_lane|separate/.test(String(p[k]))) return true;
  }
  return String(p["bicycle"] ?? "") === "designated";
}

function lineMidpoint(coords: [number, number][]): [number, number] {
  const c = coords[Math.floor(coords.length / 2)];
  return [c[0], c[1]];
}

function main(): void {
  console.log("[backlog] loading reconciliation inputs…");
  const wayTags = JSON.parse(fs.readFileSync(path.join(RECON, "way-tags.json"), "utf8")) as Record<string, WayTag>;
  const osm = JSON.parse(fs.readFileSync(path.join(RECON, "osm-ways.geojson"), "utf8")) as { features: OsmFeature[] };

  // Index OSM ways by id; collect per-name segments for the contraflow scan.
  const byId = new Map<string, OsmFeature>();
  const byName = new Map<string, { id: string; p: Record<string, unknown>; f: OsmFeature }[]>();
  for (const f of osm.features) {
    const p = f.properties ?? {};
    const id = String(p["@id"] ?? "");
    if (id) byId.set(id, f);
    const name = String(p["name"] ?? "");
    if (name) {
      const arr = byName.get(name) ?? [];
      arr.push({ id, p, f });
      byName.set(name, arr);
    }
  }

  interface Gap {
    type: "presence" | "contraflow";
    osm_way_id: string;
    name: string;
    pbot_class: PbotClass | null;
    suggested: Record<string, string>;
    geometry: { type: "LineString"; coordinates: [number, number][] };
    lng: number;
    lat: number;
    length_m: number;
  }
  const gaps: Gap[] = [];

  // ---- PRESENCE: PBOT facility ways with no OSM bike tag ----
  let presenceMissingGeom = 0;
  for (const [id, wt] of Object.entries(wayTags)) {
    const f = byId.get(id);
    if (!f?.geometry || f.geometry.type !== "LineString") { presenceMissingGeom++; continue; }
    const p = f.properties ?? {};
    if (hasBikeTag(p)) continue; // already visible to the router
    const cls = wt.bicycle_network_class;
    const coords = f.geometry.coordinates;
    const [lng, lat] = lineMidpoint(coords);
    gaps.push({
      type: "presence", osm_way_id: id, name: wt.name ?? String(p["name"] ?? ""),
      pbot_class: cls, suggested: SUGGESTED_TAGS[cls] ?? { cycleway: "lane" },
      geometry: { type: "LineString", coordinates: coords }, lng, lat,
      length_m: Math.round(wt.length_m),
    });
  }

  // ---- CONTRAFLOW: oneway=yes facility segments on a street that elsewhere
  //      declares oneway:bicycle=no but is itself missing it ----
  for (const [name, segs] of byName) {
    if (!segs.some((s) => isOnewayBike(s.p))) continue; // street must assert contraflow somewhere
    for (const s of segs) {
      if (String(s.p["oneway"] ?? "") !== "yes") continue;
      if (isOnewayBike(s.p)) continue; // already correct
      if (!hasCyclewayFacility(s.p)) continue; // only flag where there's a bike facility
      const f = s.f;
      if (!f.geometry || f.geometry.type !== "LineString") continue;
      const coords = f.geometry.coordinates;
      const [lng, lat] = lineMidpoint(coords);
      gaps.push({
        type: "contraflow", osm_way_id: s.id, name,
        pbot_class: null, suggested: { "oneway:bicycle": "no" },
        geometry: { type: "LineString", coordinates: coords }, lng, lat,
        length_m: 0,
      });
    }
  }

  // Priority: protected/greenway presence first, then by length; contraflow high.
  const clsRank: Record<string, number> = { off_street: 5, greenway: 4, protected: 3, buffered: 2, standard: 1 };
  gaps.sort((a, b) => {
    if (a.type !== b.type) return a.type === "contraflow" ? -1 : 1;
    return (clsRank[b.pbot_class ?? ""] ?? 0) - (clsRank[a.pbot_class ?? ""] ?? 0) || b.length_m - a.length_m;
  });

  // ---- Outputs ----
  fs.mkdirSync(OUT, { recursive: true });
  const tagStr = (t: Record<string, string>) => Object.entries(t).map(([k, v]) => `${k}=${v}`).join(";");

  const features = gaps.map((g, i) => ({
    type: "Feature" as const,
    properties: {
      id: i + 1, gap: g.type, osm_way_id: g.osm_way_id, name: g.name,
      pbot_class: g.pbot_class, suggested_tags: tagStr(g.suggested),
    },
    geometry: g.geometry,
  }));
  fs.writeFileSync(path.join(OUT, "osm-gaps.geojson"), JSON.stringify({ type: "FeatureCollection", features }));

  const csvRows = ["gap,osm_way_id,name,pbot_class,suggested_tags,length_m,lat,lng"];
  for (const g of gaps) csvRows.push([g.type, g.osm_way_id, `"${g.name}"`, g.pbot_class ?? "", `"${tagStr(g.suggested)}"`, g.length_m, g.lat.toFixed(6), g.lng.toFixed(6)].join(","));
  fs.writeFileSync(path.join(OUT, "osm-gaps.csv"), csvRows.join("\n"));

  // MapRoulette: newline-delimited GeoJSON, one task per line (cooperative tag-fix hint in properties).
  const mr = gaps.map((g) => JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: {
      osmid: `way/${g.osm_way_id}`, gap: g.type, name: g.name,
      instruction: g.type === "presence"
        ? `PBOT maps this as a ${g.pbot_class} bike facility but OSM has no bike tag. Verify against imagery and add: ${tagStr(g.suggested)}`
        : `This one-way street has a two-way cycle facility elsewhere but this segment lacks oneway:bicycle=no. Verify and add: ${tagStr(g.suggested)}`,
      suggested_tags: g.suggested,
    }, geometry: g.geometry }],
  })).join("\n");
  fs.writeFileSync(path.join(OUT, "maproulette.geojson"), mr);

  // Summary + SE 17th focus.
  const presence = gaps.filter((g) => g.type === "presence");
  const contraflow = gaps.filter((g) => g.type === "contraflow");
  const byClass: Record<string, number> = {};
  for (const g of presence) byClass[g.pbot_class ?? "?"] = (byClass[g.pbot_class ?? "?"] ?? 0) + 1;
  const se17 = gaps.filter((g) => /(^|\b)(SE |Southeast )?17th/i.test(g.name) && /17th/i.test(g.name));
  const summary = {
    generatedFrom: "data/reconciled/current",
    presence_gaps: presence.length,
    presence_by_class: byClass,
    contraflow_gaps: contraflow.length,
    presence_missing_geometry: presenceMissingGeom,
    se17th_gaps: se17.length,
    se17th_examples: se17.slice(0, 6).map((g) => ({ way: g.osm_way_id, gap: g.type, suggested: tagStr(g.suggested) })),
    contraflow_streets: [...new Set(contraflow.map((g) => g.name))],
  };
  fs.writeFileSync(path.join(OUT, "summary.json"), JSON.stringify(summary, null, 2));

  console.log(`[backlog] PRESENCE gaps: ${presence.length}  ${JSON.stringify(byClass)}`);
  console.log(`[backlog] CONTRAFLOW gaps: ${contraflow.length}  streets: ${summary.contraflow_streets.slice(0, 8).join(", ")}`);
  console.log(`[backlog] SE 17th gaps: ${se17.length}`);
  console.log(`[backlog] wrote osm-gaps.geojson / .csv / maproulette.geojson / summary.json → data/backlog/`);
}

main();
