#!/bin/bash
#
# build-brouter-tiles.sh — self-build the BikeRouteNicePDX BRouter segment tiles.
#
# Produces W125_N45.rd5 (+ W125_N40.rd5 southern buffer) baked with:
#   - the Phase-1 OSM-gap backlog (presence + contraflow tag adds) so BRouter
#     "sees" the PBOT bike facilities stock brouter.de tiles miss, and
#   - SRTM1 elevation so hilly routes (Marquam Hill / OHSU) still prefer greenways.
#
# Avoids the prior self-build's two failures: a too-tight crop (edge-truncated
# dead-ends) and no quality gate. The extract is a *generously buffered* Portland
# region (~180 km square spanning both N45 + N40 tiles), and the build is followed
# by an explicit A/B vs brouter.de (see "Quality gate" in PLAN / docs).
#
# Pipeline (BRouter v1.7.9 map-creator, pure Java — no Docker needed):
#   1. osmium extract+merge a buffered Portland crop from Geofabrik OR + WA
#   2. pyosmium read-modify-write applies the backlog tags  (patch-osm-tags.py)
#   3. SRTM1 HGT (AWS skadi) -> .bef            (ElevationRasterTileConverter)
#   4. OsmFastCutter -> PosUnifier -> WayLinker -> *.rd5
#
# Prereqs (macOS): brew install openjdk@21 osmium-tool ; python venv w/ pyosmium.
# All heavy inputs/intermediates live under data/brouter-build/ (gitignored).
#
# Usage:  bash scripts/build-brouter-tiles.sh
#         NO_ELEVATION=1 bash scripts/build-brouter-tiles.sh   # skip SRTM (faster, hillier routes regress)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
BD="$REPO/data/brouter-build"
JAVA="${JAVA:-/opt/homebrew/opt/openjdk@21/bin/java}"
OSMIUM="${OSMIUM:-/opt/homebrew/bin/osmium}"
DIST="$BD/tools/brouter/brouter-1.7.9"
JAR="$DIST/brouter-1.7.9-all.jar"
PROF="$DIST/profiles2"
PY="$BD/venv/bin/python"
BBOX="-123.8,44.6,-121.5,46.3"          # generously buffered Portland metro (spans N45 + N40)
XMX="${XMX:-5g}"

mkdir -p "$BD/pbf" "$BD/work" "$BD/hgt"

# 1. extract + merge -------------------------------------------------------
for st in oregon washington; do
  [ -f "$BD/pbf/$st-latest.osm.pbf" ] || \
    curl -fSL -o "$BD/pbf/$st-latest.osm.pbf" "https://download.geofabrik.de/north-america/us/$st-latest.osm.pbf"
  "$OSMIUM" extract -b "$BBOX" "$BD/pbf/$st-latest.osm.pbf" -o "$BD/work/$st-crop.osm.pbf" --overwrite
done
"$OSMIUM" merge "$BD/work/oregon-crop.osm.pbf" "$BD/work/washington-crop.osm.pbf" \
  -o "$BD/work/portland-region.osm.pbf" --overwrite

# 2. patch backlog tags ----------------------------------------------------
rm -f "$BD/work/portland-region-patched.osm.pbf"
"$PY" "$BD/patch-osm-tags.py" "$REPO/data/backlog/osm-gaps.csv" \
  "$BD/work/portland-region.osm.pbf" "$BD/work/portland-region-patched.osm.pbf"

# 3. SRTM1 HGT -> .bef -----------------------------------------------------
B="$BD/build"
mkdir -p "$B/tmp/nodetiles" "$B/tmp/waytiles" "$B/tmp/waytiles55" "$B/tmp/nodes55" \
         "$B/tmp/unodes55" "$B/tmp/segments" "$B/srtm1_bef" "$B/srtm3_bef"
if [ "${NO_ELEVATION:-0}" != "1" ]; then
  for lat in 44 45 46; do for lon in 122 123 124 125; do
    t="N${lat}W${lon}"
    [ -f "$BD/hgt/$t.hgt" ] && continue
    curl -fsSL "https://s3.amazonaws.com/elevation-tiles-prod/skadi/N${lat}/${t}.hgt.gz" \
      -o "$BD/hgt/$t.hgt.gz" && gunzip -f "$BD/hgt/$t.hgt.gz" || echo "warn: no $t"
  done; done
  for tile in srtm_12_03 srtm_12_04; do
    [ -f "$B/srtm1_bef/$tile.bef" ] || \
      "$JAVA" -Xmx2g -cp "$JAR" btools.mapcreator.ElevationRasterTileConverter "$tile" "$BD/hgt" "$B/srtm1_bef" 1
  done
fi

# 4. three-stage map-creator ----------------------------------------------
cd "$B"
echo "[build] STAGE 1/3 OsmFastCutter"
"$JAVA" -Xmx$XMX -Xms512m -Xmn256M -cp "$JAR" -Ddeletetmpfiles=true -DuseDenseMaps=true \
  btools.mapcreator.OsmFastCutter "$PROF/lookups.dat" \
  tmp/nodetiles tmp/waytiles tmp/nodes55 tmp/waytiles55 \
  tmp/bordernids.dat tmp/relations.dat tmp/restrictions.dat \
  "$PROF/all.brf" "$PROF/trekking.brf" "$PROF/softaccess.brf" \
  ../work/portland-region-patched.osm.pbf

echo "[build] STAGE 2/3 PosUnifier (elevation: ${NO_ELEVATION:+OFF}${NO_ELEVATION:-ON})"
"$JAVA" -Xmx$XMX -Xms512m -Xmn256M -cp "$JAR" -Ddeletetmpfiles=true -DuseDenseMaps=true \
  btools.mapcreator.PosUnifier \
  tmp/nodes55 tmp/unodes55 tmp/bordernids.dat tmp/bordernodes.dat \
  srtm1_bef srtm3_bef

echo "[build] STAGE 3/3 WayLinker"
"$JAVA" -Xmx$XMX -Xms512m -Xmn256M -cp "$JAR" -DuseDenseMaps=true -DskipEncodingCheck=true \
  btools.mapcreator.WayLinker \
  tmp/unodes55 tmp/waytiles55 tmp/bordernodes.dat tmp/restrictions55 \
  "$PROF/lookups.dat" "$PROF/all.brf" tmp/segments rd5

mkdir -p "$BD/out"
cp tmp/segments/*.rd5 "$BD/out/"
echo "[build] done -> $BD/out/"
ls -la "$BD/out/"
