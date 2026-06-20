--[[
  ⚠️  SUPERSEDED / NOT WIRED IN  ⚠️
  As of the baked-tag pipeline, greenway preference is written directly onto OSM
  ways in portland-tagged.osm.pbf by scripts/build-graph.ts (bakeTagsIntoPbf),
  so STOCK Valhalla with its default Lua already prefers greenways. This file is
  no longer referenced by routing/valhalla.json and is retained only because it
  documents the class→standard-tag costing rationale (mirrored in build-graph's
  CLASS_TAGS). Using a custom Lua with Valhalla is fragile: the key is
  `graph_lua_name`, and a custom file REPLACES Valhalla's entire default tag
  transform (so it would need to be the full default Lua + these edits, version-
  matched to the image). The bake approach avoids all of that.

  ── Original header ────────────────────────────────────────────────────────
  graph.lua — Valhalla Lua tagging callback for BikeRouteNicePDX
  Loaded by mjolnir at tile-build time via valhalla.json -> mjolnir.lua

  Purpose
  -------
  OSM ways in portland-tagged.osm.pbf have been annotated by
  scripts/build-graph.ts with a custom tag:
      bicycle_network_class = "greenway" | "off_street" | "protected" |
                              "buffered" | "standard" | "arterial_no_bike"
  and optionally:
      bicycle_difficult_crossings = "<count>"

  Valhalla's bicycle costing reads standard OSM tags (cycleway=*, bicycle=*,
  highway=*, etc.) but cannot consume arbitrary custom tags directly.
  This script translates our custom tags into Valhalla-native attributes that
  the bicycle costing engine understands.

  Approach
  --------
  The per-way bicycle_network_class is NOT present as an OSM tag on the way
  (scripts/build-graph.ts does not rewrite the PBF). Instead it lives in the
  way-tags.json sidecar, keyed by OSM way id. We look it up here and translate
  it into standard OSM tags Valhalla's bicycle costing actually reads
  (highway / cycleway / bicycle / lcn). We do NOT set bicycle_safety — Valhalla
  ignores unknown per-edge tags, so it was a no-op.

  Sidecar JSON (/data/way-tags.json)
  -----------------------------------
  Loaded once at module startup, keyed by OSM way id (string). Produced by
  scripts/build-graph.ts. Each entry:
      { "<way_id>": {
          "bicycle_network_class": "greenway",      -- drives the tag mapping
          "difficult_crossing_penalty_s": 60,       -- reserved (see TODO)
          "name": "NE Going St", ...
      } }

  We use cjson (shipped with gisops/valhalla) or dkjson as a fallback.
  If neither is present, or if the sidecar file is missing, we log a
  warning and operate on OSM-tag-based classification only (no PBOT bias).
--]]

-- ── COST DIFFERENTIATION VIA STANDARD TAGS ───────────────────────────────────
-- We do NOT use a bicycle_safety tag: Valhalla's bicycle costing ignores
-- arbitrary per-edge tags. The only levers that actually move cost are the
-- standard OSM tags (highway / cycleway / bicycle / lcn) plus the request-time
-- use_roads / use_hills options. So each bicycle_network_class is mapped below
-- to the standard-tag combination that yields the desired cost ordering:
--
--   off_street ≈ greenway ≈ protected  >  buffered ≈ standard  >  residential
--   >  collector/arterial (penalized natively by road class + use_roads)
--
-- Key subtlety: a quiet neighborhood greenway has no painted lane, so with
-- native tags alone Valhalla scores it BELOW a painted bike lane (cycleway=lane)
-- on a busier street — which is what pulls routes off greenways mid-route. To
-- correct that we tag greenways as separated infra (cycleway=track) AND set
-- lcn=yes for the bike-network bonus, lifting them above buffered/standard.
-- This is a deliberate routing-bias overstatement (greenways aren't physically
-- separated); it may surface "bike path" wording in turn-by-turn directions.

-- ── SIDECAR LOADING ───────────────────────────────────────────────────────────
local SIDECAR_PATH = "/data/way-tags.json"
local way_sidecar  = {}  -- keyed by way_id string; populated below

local function load_sidecar()
  -- Try cjson first (compiled C module, ships with gisops/valhalla image).
  -- Fall back to dkjson (pure Lua, sometimes bundled separately).
  local json_ok, json = pcall(require, "cjson")
  if not json_ok then
    json_ok, json = pcall(require, "dkjson")
    if not json_ok then
      io.stderr:write("[graph.lua] WARNING: neither cjson nor dkjson found; "
        .. "sidecar-based per-way data (difficult crossings) will be skipped.\n")
      return
    end
    io.stderr:write("[graph.lua] INFO: using dkjson for sidecar parsing.\n")
  else
    io.stderr:write("[graph.lua] INFO: using cjson for sidecar parsing.\n")
  end

  local f, err = io.open(SIDECAR_PATH, "r")
  if not f then
    io.stderr:write("[graph.lua] WARNING: sidecar not found at "
      .. SIDECAR_PATH .. " (" .. tostring(err) .. "). "
      .. "Proceeding with OSM-tag-based classification only.\n")
    return
  end

  local content = f:read("*a")
  f:close()

  local ok, data = pcall(json.decode, content)
  if not ok or type(data) ~= "table" then
    io.stderr:write("[graph.lua] WARNING: failed to parse sidecar JSON: "
      .. tostring(data) .. ". "
      .. "Proceeding with OSM-tag-based classification only.\n")
    return
  end

  way_sidecar = data
  local count = 0
  for _ in pairs(way_sidecar) do count = count + 1 end
  io.stderr:write("[graph.lua] INFO: loaded " .. count
    .. " way entries from sidecar.\n")
end

-- Load at module startup (once per tile-build process).
load_sidecar()


-- ── MAIN CALLBACK ─────────────────────────────────────────────────────────────
--
-- Valhalla calls this function once per OSM way during tile construction.
--
-- Parameters:
--   way_id  (integer) — OSM way ID
--   tags    (table)   — mutable tag table for this way; write to override
--   nodes   (table)   — node IDs in the way (usually read-only)
--   values  (table)   — internal Valhalla values table (usually read-only)
--
-- We look up the way's bicycle_network_class in the sidecar (keyed by way_id)
-- and translate it into standard Valhalla tags so the costing engine weights
-- the edge correctly. No bicycle_safety — Valhalla ignores it.

function way_function(way_id, tags, nodes, values)
  -- Class is NOT an OSM tag on the way; it comes from the sidecar by way_id.
  local entry = way_sidecar[tostring(way_id)]
  local bnc   = entry and entry.bicycle_network_class

  -- ── Per-class tag rewriting ──────────────────────────────────────────────
  if bnc == "off_street" then
    -- Dedicated off-street path (Springwater, Esplanade, Marine Drive).
    -- Valhalla treats highway=cycleway as the highest-priority cycling infra.
    tags["highway"]  = tags["highway"] or "cycleway"
    tags["bicycle"]  = "designated"
    tags["foot"]     = tags["foot"] or "yes"  -- shared paths allow pedestrians

  elseif bnc == "greenway" then
    -- PBOT-designated neighborhood greenway. A quiet residential street with no
    -- painted lane would natively score BELOW a striped bike lane, so we tag it
    -- as separated infra (cycleway=track) + bike-network (lcn) to lift it above
    -- buffered/standard. Deliberate bias — greenways are the product's core.
    tags["cycleway"] = "track"
    tags["bicycle"]  = "designated"
    tags["lcn"]      = "yes"  -- local cycle network — Valhalla's bike-net bonus

  elseif bnc == "protected" then
    -- Physically separated bike lane (Naito Pkwy, NE Multnomah).
    tags["cycleway"] = "track"   -- OSM tag for fully protected/separated lane
    tags["bicycle"]  = "designated"

  elseif bnc == "buffered" then
    -- Painted buffer between travel lane and bike lane (NE Williams).
    tags["cycleway"] = "lane"    -- Valhalla reads this; "buffered" isn't standard

  elseif bnc == "standard" then
    -- Striped bike lane with no buffer.
    tags["cycleway"] = "lane"

  elseif bnc == "arterial_no_bike" then
    -- High-speed arterial with no cycling infrastructure. We don't block the
    -- way (that would prevent routing if the user has no alternative), but we
    -- strip any stray affirmative bicycle tags so Valhalla doesn't treat it as
    -- a comfortable cycling route; road class + use_roads price it out.
    if tags["bicycle"] == "yes" or tags["bicycle"] == "designated" then
      tags["bicycle"] = "no"
    end

  end
  -- If bnc is nil / unrecognized, leave tags untouched; Valhalla's standard
  -- OSM-based costing applies. This is the correct fallback for residential
  -- streets without PBOT data.

  -- ── Difficult-crossing penalty — DEFERRED ────────────────────────────────
  -- The old implementation folded a per-crossing penalty into bicycle_safety,
  -- which Valhalla ignores, so it never did anything. A correct implementation
  -- belongs in node_function (apply a crossing/gate-style penalty at the
  -- intersection node), using the PBOT difficult-crossing points. The sidecar
  -- still carries entry.difficult_crossing_penalty_s for when that lands.
  -- TODO(follow-up): per-crossing penalty via node_function.
end


-- ── NODE CALLBACK ─────────────────────────────────────────────────────────────
--
-- Called for each OSM node during tile construction.
-- We don't currently need to override node behavior beyond Valhalla's defaults,
-- but the function must be defined if mjolnir.lua is set.
-- Future use: apply explicit crossing penalties at intersection nodes.

function node_function(node_id, tags, values)
  -- No-op for now.
  -- TODO (Phase 2): look up node_id in a PBOT difficult-crossings node sidecar
  -- and apply a gate_penalty-equivalent so the penalty is per-crossing, not
  -- spread across the entire way.
end
