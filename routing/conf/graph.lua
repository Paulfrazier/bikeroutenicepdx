--[[
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
  We set two things Valhalla does read:
    1. cycleway / bicycle tags — influence the edge's infrastructure class
    2. bicycle_safety (float 0..1, lower = safer) — used as an edge-weight
       multiplier in Valhalla's bicycle costing

  The bicycle_safety mapping mirrors costing-overrides.json. Any factor
  change must be applied here too (Lua cannot import JSON at build time).

  Sidecar JSON (/data/way-tags.json)
  -----------------------------------
  For per-way lookups that cannot be expressed as simple OSM tags
  (e.g. difficult-crossing counts which come from a PBOT point layer,
  not the way geometry), we load a JSON sidecar at module startup.

  Format:
      { "<way_id>": { "class": "greenway", "difficult_crossings": 2 } }

  We use cjson (shipped with gisops/valhalla) or dkjson as a fallback.
  If neither is present, or if the sidecar file is missing, we log a
  warning and operate on OSM-tag-based classification only.

  Duplicate-value note
  --------------------
  The SAFETY_MAP constants below must match the bicycle_safety_mapping in
  costing-overrides.json. They are duplicated because Lua runs inside the
  mjolnir tile-build sandbox and cannot perform cross-file JSON imports for
  the global factor table (the sidecar is per-way data and is handled
  separately, below).
--]]

-- ── SAFETY MAP ────────────────────────────────────────────────────────────────
-- Maps bicycle_network_class → bicycle_safety float.
-- Lower values = more preferred edges.
-- Mirror of costing-overrides.json → _notes.bicycle_safety_mapping.
local SAFETY_MAP = {
  off_street       = 0.1,
  greenway         = 0.2,
  protected        = 0.4,
  buffered         = 0.6,
  standard         = 0.8,
  arterial_no_bike = 1.0,
  -- residential has no explicit class tag; Valhalla's defaults handle it
}

-- Difficult-crossing time penalty in seconds.
-- Mirror of costing-overrides.json → penalties.difficult_crossing_seconds.
local DIFFICULT_CROSSING_PENALTY_S = 60

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
-- We read our custom tag bicycle_network_class, set standard Valhalla tags,
-- and set bicycle_safety so the costing engine weights this edge correctly.

function way_function(way_id, tags, nodes, values)
  local bnc = tags["bicycle_network_class"]

  -- ── Per-class tag rewriting ──────────────────────────────────────────────
  if bnc == "off_street" then
    -- Dedicated off-street path (Springwater, Esplanade, Marine Drive).
    -- Valhalla treats highway=cycleway as the highest-priority cycling infra.
    tags["highway"]  = tags["highway"] or "cycleway"
    tags["bicycle"]  = "designated"
    tags["foot"]     = tags["foot"] or "yes"  -- shared paths allow pedestrians
    tags["bicycle_safety"] = tostring(SAFETY_MAP.off_street)

  elseif bnc == "greenway" then
    -- PBOT-designated neighborhood greenway.
    -- Keep the highway class (residential) but signal premium bike comfort.
    tags["bicycle"] = "designated"
    tags["lcn"]     = "yes"  -- local cycle network — Valhalla reads this
    tags["bicycle_safety"] = tostring(SAFETY_MAP.greenway)

  elseif bnc == "protected" then
    -- Physically separated bike lane (Naito Pkwy, NE Multnomah).
    tags["cycleway"] = "track"   -- OSM tag for fully protected/separated lane
    tags["bicycle"] = "designated"
    tags["bicycle_safety"] = tostring(SAFETY_MAP.protected)

  elseif bnc == "buffered" then
    -- Painted buffer between travel lane and bike lane (NE Williams).
    tags["cycleway"] = "lane"    -- Valhalla reads this; "buffered" isn't standard
    tags["bicycle_safety"] = tostring(SAFETY_MAP.buffered)

  elseif bnc == "standard" then
    -- Striped bike lane with no buffer.
    tags["cycleway"] = "lane"
    tags["bicycle_safety"] = tostring(SAFETY_MAP.standard)

  elseif bnc == "arterial_no_bike" then
    -- High-speed arterial with no cycling infrastructure.
    -- We don't block the way (that would prevent routing entirely if the user
    -- has no alternative), but we price it very high and strip any stray
    -- bicycle=yes tags that OSM might have.
    tags["bicycle_safety"] = tostring(SAFETY_MAP.arterial_no_bike)
    -- Remove any affirmative bicycle tags that would make Valhalla think
    -- this is a comfortable cycling route.
    if tags["bicycle"] == "yes" or tags["bicycle"] == "designated" then
      tags["bicycle"] = "no"
    end

  end
  -- If bnc is nil / unrecognized, leave tags untouched; Valhalla's standard
  -- OSM-based costing applies. This is the correct fallback for residential
  -- streets without PBOT data.

  -- ── Difficult-crossing penalty (via sidecar) ─────────────────────────────
  -- Sidecar entry may carry a difficult_crossings count from PBOT point data.
  -- Valhalla doesn't have a per-way "crossing penalty" tag, so we fold the
  -- penalty into the bicycle_safety score by raising it slightly.
  -- Each difficult crossing adds an equivalent "safety penalty" proportional
  -- to DIFFICULT_CROSSING_PENALTY_S / 3600 (seconds → fraction of an hour).
  --
  -- This is an approximation: ideally we would penalise intersecting nodes
  -- rather than the whole way. That requires Valhalla's node_function callback
  -- (see node_function below). The way-level bump is a conservative fallback.

  local wid_str = tostring(way_id)
  local entry   = way_sidecar[wid_str]
  if entry and entry.difficult_crossings and entry.difficult_crossings > 0 then
    local current_safety = tonumber(tags["bicycle_safety"]) or 1.0
    -- Each crossing adds ~0.017 safety penalty (60s / 3600s).
    -- Cap at 0.95 so we never fully block a way just from crossing penalties.
    local penalty = entry.difficult_crossings * (DIFFICULT_CROSSING_PENALTY_S / 3600)
    local adjusted = math.min(0.95, current_safety + penalty)
    tags["bicycle_safety"] = tostring(adjusted)
  end
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
