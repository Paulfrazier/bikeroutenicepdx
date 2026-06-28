import MapKit

/// Tappable metadata for one built-but-unpublished "supplement" lane segment.
/// Holds the SAME `MKPolyline` instance that lives inside the rendered
/// `BikeMultiPolyline` overlay (referenced by identity), so a screen-space tap
/// can be matched back to its build note + source link. We DON'T subclass
/// MKPolyline (it's a class cluster — subclassing breaks); the metadata rides
/// alongside in this parallel list instead.
struct SupplementLine {
    let polyline: MKPolyline
    let name: String
    let buildNote: String
    let sourceURL: String
}

/// The reader-facing payload shown in the "learn more about this network" panel
/// when a supplement lane is tapped. Identifiable so RootView can drive a
/// `.sheet(item:)` from it.
struct SupplementInfo: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let buildNote: String
    let sourceURL: String
}

/// Loads the bundled `bike-network.geojson` and keeps ONLY the "supplement"
/// features (PBOT lanes built 2024-2026, not yet in the published GIS). Returns
/// both the render overlays (bucketed by `BikeClass` exactly like
/// `BikeNetworkLoader`, so the existing renderer draws them identically) and a
/// flat `hits` list for tap hit-testing. `BikeNetworkLoader` skips these same
/// features, so nothing is drawn twice.
enum SupplementNetworkLoader {
    static func load() -> (overlays: [BikeMultiPolyline], hits: [SupplementLine]) {
        guard
            let url = Bundle.main.url(forResource: "bike-network", withExtension: "geojson"),
            let rawData = try? Data(contentsOf: url)
        else {
            return ([], [])
        }

        // Same pre-clean as BikeNetworkLoader: one degenerate feature must not
        // make MKGeoJSONDecoder throw and blank the whole collection.
        let data = BikeNetworkLoader.sanitized(rawData) ?? rawData
        guard let objects = try? MKGeoJSONDecoder().decode(data) else { return ([], []) }

        var byClass: [BikeClass: [MKPolyline]] = [:]
        var hits: [SupplementLine] = []
        for object in objects {
            guard let feature = object as? MKGeoJSONFeature else { continue }
            guard BikeNetworkLoader.isSupplement(feature.properties) else { continue }
            let cls = BikeNetworkLoader.bikeClass(from: feature.properties)
            let meta = BikeNetworkLoader.supplementMeta(from: feature.properties)
            for geometry in feature.geometry {
                if let line = geometry as? MKPolyline {
                    append(line, cls: cls, meta: meta, to: &byClass, hits: &hits)
                } else if let multi = geometry as? MKMultiPolyline {
                    for line in multi.polylines {
                        append(line, cls: cls, meta: meta, to: &byClass, hits: &hits)
                    }
                }
            }
        }

        // One MKMultiPolyline per class, low-priority first — identical bucketing
        // / z-order to BikeNetworkLoader so supplements match the official palette.
        // NOTE: the SAME MKPolyline objects appended to `hits` go into these
        // overlays, so tap hit-testing references the rendered geometry.
        let overlays = BikeClass.allCases
            .sorted { $0.zPriority < $1.zPriority }
            .compactMap { cls -> BikeMultiPolyline? in
                guard let lines = byClass[cls], !lines.isEmpty else { return nil }
                let overlay = BikeMultiPolyline(lines)
                overlay.bikeClass = cls
                return overlay
            }
        return (overlays, hits)
    }

    private static func append(
        _ line: MKPolyline,
        cls: BikeClass,
        meta: (name: String, buildNote: String, sourceURL: String),
        to byClass: inout [BikeClass: [MKPolyline]],
        hits: inout [SupplementLine]
    ) {
        byClass[cls, default: []].append(line)
        hits.append(SupplementLine(
            polyline: line,
            name: meta.name,
            buildNote: meta.buildNote,
            sourceURL: meta.sourceURL
        ))
    }
}
