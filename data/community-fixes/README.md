# Community Fixes — source data

Each file in this directory represents one admin-approved connector geometry (a
missing path, a cut-through, a bridge approach, etc.) that the community has
validated and that an admin has accepted.

## File format

Each `<id>.geojson` is EITHER:

- a single **Feature** (LineString or MultiLineString), or
- a **FeatureCollection** containing one or more LineString / MultiLineString
  features.

Each feature may carry an optional `properties.name` string (used by the overlay
legend on the map). All other properties are passed through untouched but ignored
by the renderer.

Example minimal Feature:

```json
{
  "type": "Feature",
  "geometry": {
    "type": "LineString",
    "coordinates": [[-122.65, 45.5122], [-122.65, 45.5128]]
  },
  "properties": { "name": "SE 16th connector" }
}
```

## Naming convention

Use a short kebab-case id for the filename — ideally matching the issue or PR
number that approved the fix, e.g. `fix-042-se16th-connector.geojson`.

## Build pipeline

`npm run export:community-fixes` (at the repo root) reads every `*.geojson` in
this directory, merges all features, drops degenerate geometry (<2 points), rounds
coordinates to 5 decimal places (~1 m), and writes the result to:

- `web/public/community-fixes.geojson`
- `ios/BikeRouteNicePDX/Resources/community-fixes.geojson`

The two output files are always written together and must stay identical —
`npm run check:data` enforces this.

## Removing the example fixture

`_example.geojson` (the file starting with `_`) is a minimal smoke-test fixture
used to verify the export pipeline end-to-end. **Delete it before shipping any
real community fixes** so a placeholder connector does not appear on the map for
real users.
