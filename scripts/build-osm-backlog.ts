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
 *   CONTRAFLOW— a `oneway=yes` facility segment that is an ENCLOSED HOLE inside a
 *               contiguous two-way cycletrack: BOTH its endpoints touch a segment
 *               that already asserts `oneway:bicycle=no`, but it itself is missing
 *               that tag, so the router refuses contraflow at the gap. Geometry
 *               adjacency + same-name continuity, NOT street-name grouping (which
 *               propagated the tag down whole one-way arterials like N Williams and
 *               routed bikes the wrong way). Currently flags 1 (an SW Naito hole).
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

  // Index OSM ways by id.
  const byId = new Map<string, OsmFeature>();
  for (const f of osm.features) {
    const p = f.properties ?? {};
    const id = String(p["@id"] ?? "");
    if (id) byId.set(id, f);
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

  // ---- CONTRAFLOW: fill a genuine HOLE in a contiguous two-way cycletrack ----
  //   A oneway=yes facility segment is flagged ONLY if BOTH its endpoints touch a
  //   segment that already asserts oneway:bicycle=no (an enclosed gap inside a real
  //   two-way run). The previous rule grouped by street NAME and propagated the tag
  //   to every same-named oneway=yes segment off a single assertion. That spammed
  //   oneway:bicycle=no down entire one-way arterials — e.g. 3 stray assertions on
  //   N Williams flagged 44 northbound segments, so the self-build router rode bikes
  //   the WRONG WAY southbound (Williams is one-way NB; southbound bikes use Vancouver).
  //   The same name-collision hit SW Broadway, NE Weidler, SE Washington, Hawthorne
  //   Bridge, etc. Geometry adjacency confines the fix to actual holes: across the
  //   whole city this currently flags 1 segment (a real SW Naito / Better Naito
  //   two-way hole); all the name-collision false positives are gone.
  const nodeKey = (c: [number, number]): string => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;
  const assertNodes = new Map<string, Set<string>>(); // node -> ids of oneway:bicycle=no ways touching it
  for (const f of osm.features) {
    const p = f.properties ?? {};
    if (!isOnewayBike(p) || !f.geometry || f.geometry.type !== "LineString") continue;
    const cs = f.geometry.coordinates;
    if (cs.length < 2) continue;
    const id = String(p["@id"] ?? "");
    for (const end of [cs[0], cs[cs.length - 1]]) {
      const k = nodeKey(end);
      (assertNodes.get(k) ?? assertNodes.set(k, new Set<string>()).get(k)!).add(id);
    }
  }
  for (const f of osm.features) {
    const p = f.properties ?? {};
    if (String(p["oneway"] ?? "") !== "yes") continue;
    if (isOnewayBike(p)) continue; // already correct
    if (!hasCyclewayFacility(p)) continue; // only where there's a bike facility
    if (!f.geometry || f.geometry.type !== "LineString") continue;
    const coords = f.geometry.coordinates;
    if (coords.length < 2) continue;
    const id = String(p["@id"] ?? "");
    const name = String(p["name"] ?? "");
    if (!name) continue; // need a name to prove same-cycletrack continuity
    // Enclosed = each endpoint touches an asserting segment of the SAME street name
    // (a real two-way cycletrack continuing through this gap). Requiring same-name
    // rejects coincidental intersections of two unrelated contraflow streets — e.g. a
    // Williams segment whose ends merely touch N Jessup + a stray Williams assertion,
    // or an NW 18th segment bracketed by NW Pettygrove + NW Johnson. Those would still
    // route bikes the wrong way down a one-way arterial.
    const sameNameAssertAt = (c: [number, number]): boolean => {
      const ids = assertNodes.get(nodeKey(c));
      if (!ids) return false;
      for (const x of ids) {
        if (x === id) continue;
        if (String((byId.get(x)?.properties ?? {})["name"] ?? "") === name) return true;
      }
      return false;
    };
    if (!sameNameAssertAt(coords[0]) || !sameNameAssertAt(coords[coords.length - 1])) continue;
    const [lng, lat] = lineMidpoint(coords);
    gaps.push({
      type: "contraflow", osm_way_id: id, name,
      pbot_class: null, suggested: { "oneway:bicycle": "no" },
      geometry: { type: "LineString", coordinates: coords }, lng, lat,
      length_m: 0,
    });
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
