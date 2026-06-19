import MapKit

/// Loads the bundled bike-network.geojson (the full City of Portland Bicycle
/// Network) and returns one MKMultiPolyline overlay per facility class, sorted
/// so higher-quality facilities render on top.
enum BikeNetworkLoader {
    static func loadOverlays() -> [BikeMultiPolyline] {
        guard
            let url = Bundle.main.url(forResource: "bike-network", withExtension: "geojson"),
            let rawData = try? Data(contentsOf: url)
        else {
            return []
        }

        // MKGeoJSONDecoder decodes a FeatureCollection atomically: a SINGLE
        // feature with empty/degenerate coordinates makes it throw `nilError`
        // and blanks the entire overlay. Pre-clean degenerate features so one
        // bad row can never wipe out the whole network.
        let data = sanitized(rawData) ?? rawData
        guard let objects = try? MKGeoJSONDecoder().decode(data) else { return [] }

        // Bucket every segment by its display class.
        var byClass: [BikeClass: [MKPolyline]] = [:]
        for object in objects {
            guard let feature = object as? MKGeoJSONFeature else { continue }
            let cls = bikeClass(from: feature.properties)
            for geometry in feature.geometry {
                if let line = geometry as? MKPolyline {
                    byClass[cls, default: []].append(line)
                } else if let multi = geometry as? MKMultiPolyline {
                    byClass[cls, default: []].append(contentsOf: multi.polylines)
                }
            }
        }

        // One MKMultiPolyline per class, added low-priority first so protected /
        // greenway lines sit on top of plain lanes.
        let result = BikeClass.allCases
            .sorted { $0.zPriority < $1.zPriority }
            .compactMap { cls -> BikeMultiPolyline? in
                guard let lines = byClass[cls], !lines.isEmpty else { return nil }
                let overlay = BikeMultiPolyline(lines)
                overlay.bikeClass = cls
                return overlay
            }
        return result
    }

    /// Strip features whose geometry has too few coordinates to form a line.
    /// Returns re-serialized data, or nil if the input isn't the expected shape
    /// (in which case the caller falls back to the raw data).
    private static func sanitized(_ data: Data) -> Data? {
        guard
            var root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let features = root["features"] as? [[String: Any]]
        else {
            return nil
        }
        let cleaned = features.filter { feature in
            guard
                let geometry = feature["geometry"] as? [String: Any],
                let type = geometry["type"] as? String,
                let coords = geometry["coordinates"] as? [Any]
            else {
                return false
            }
            switch type {
            case "LineString":
                return coords.count >= 2
            case "MultiLineString":
                return coords.contains { ($0 as? [Any])?.count ?? 0 >= 2 }
            default:
                return false
            }
        }
        guard cleaned.count != features.count else { return nil } // nothing to drop
        root["features"] = cleaned
        return try? JSONSerialization.data(withJSONObject: root)
    }

    /// Parse the feature's `class` property (raw JSON Data) into a BikeClass.
    private static func bikeClass(from data: Data?) -> BikeClass {
        guard
            let data,
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let raw = obj["class"] as? String,
            let cls = BikeClass(rawValue: raw)
        else {
            return .lane
        }
        return cls
    }
}
