#!/usr/bin/env bash
# Stage the greenway-tagged PBF for the local Valhalla container.
# Copies data/reconciled/current/portland-tagged.osm.pbf into routing/custom_files/
# (where the docker-valhalla image expects it). Run `npm run build:graph` first.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="data/reconciled/current/portland-tagged.osm.pbf"
DEST="routing/custom_files"
[ -f "$SRC" ] || { echo "missing $SRC — run: npm run build:graph -- --force"; exit 1; }
mkdir -p "$DEST"
# Remove any previously built tiles so the new PBF takes effect.
rm -rf "$DEST"/*.pbf "$DEST"/valhalla_tiles "$DEST"/valhalla_tiles.tar "$DEST"/*.sqlite "$DEST"/*.json 2>/dev/null || true
cp "$SRC" "$DEST/portland-tagged.osm.pbf"
echo "staged $(du -h "$DEST/portland-tagged.osm.pbf" | cut -f1) → $DEST/portland-tagged.osm.pbf"
