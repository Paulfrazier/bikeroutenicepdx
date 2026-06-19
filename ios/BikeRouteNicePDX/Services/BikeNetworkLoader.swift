import MapKit

/// Loads the bundled bike-network.geojson (the full City of Portland Bicycle
/// Network) and returns one MKMultiPolyline overlay per facility class, sorted
/// so higher-quality facilities render on top.
enum BikeNetworkLoader {
    static func loadOverlays() -> [BikeMultiPolyline] {
        guard
            let url = Bundle.main.url(forResource: "bike-network", withExtension: "geojson"),
            let data = try? Data(contentsOf: url),
            let objects = try? MKGeoJSONDecoder().decode(data)
        else {
            return []
        }

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
        return BikeClass.allCases
            .sorted { $0.zPriority < $1.zPriority }
            .compactMap { cls in
                guard let lines = byClass[cls], !lines.isEmpty else { return nil }
                let overlay = BikeMultiPolyline(lines)
                overlay.bikeClass = cls
                return overlay
            }
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
