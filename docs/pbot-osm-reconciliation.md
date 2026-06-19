# PBOT / OSM Reconciliation

`scripts/build-graph.ts` joins PBOT's bicycle network lines onto OSM ways via spatial proximity (~5m tolerance, segment overlap >50% of way length). When matched, the OSM way gets an injected `bicycle_network_class` tag.

`scripts/reconcile.ts` emits two CSVs to `data/reconciled/divergence-<date>/`:

## `pbot-not-in-osm.csv`

PBOT greenway segments with no OSM counterpart within tolerance. Likely causes:
- OSM way is missing entirely (rare in Portland — well-mapped)
- OSM way is geometrically off (alignment drift)
- PBOT segment is short / disconnected

These are candidates for upstream OSM edits in v1.0.

## `osm-lcn-not-in-pbot.csv`

OSM ways tagged `lcn=yes` or `bicycle=designated` with no matching PBOT greenway. Likely causes:
- Mapper marked it informally — the street is bike-friendly but not officially designated
- Stale OSM tag (greenway was reclassified)
- Genuine PBOT data gap (rare)

These do **not** get the greenway cost factor in the final routing graph — PBOT wins.

## Tolerance tuning

Default 5m / 50% overlap. If reconcile CSVs are too noisy:
- Tighten to 3m / 70% overlap (fewer false matches, more divergence)
- Loosen to 8m / 30% overlap (more false matches, less divergence)

Calibrate against canonical test route correctness, not CSV size.
