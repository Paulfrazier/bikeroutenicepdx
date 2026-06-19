import MapKit

/// Loads the bundled greenways.geojson and returns it as styled overlays.
enum GreenwayLoader {
    static func loadOverlays() -> [GreenwayPolyline] {
        guard
            let url = Bundle.main.url(forResource: "greenways", withExtension: "geojson"),
            let data = try? Data(contentsOf: url),
            let objects = try? MKGeoJSONDecoder().decode(data)
        else {
            return []
        }

        var overlays: [GreenwayPolyline] = []
        for object in objects {
            guard let feature = object as? MKGeoJSONFeature else { continue }
            for geometry in feature.geometry {
                if let line = geometry as? MKPolyline {
                    overlays.append(rebuild(line))
                } else if let multi = geometry as? MKMultiPolyline {
                    for line in multi.polylines { overlays.append(rebuild(line)) }
                }
            }
        }
        return overlays
    }

    /// Copy a decoded MKPolyline's coordinates into a GreenwayPolyline so the
    /// renderer can branch on the subclass.
    private static func rebuild(_ line: MKPolyline) -> GreenwayPolyline {
        let coords = line.coordinatesArray
        return GreenwayPolyline(coordinates: coords, count: coords.count)
    }
}
