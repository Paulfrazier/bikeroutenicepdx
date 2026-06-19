import CoreLocation

/// Small geodesic helpers shared by the route store and coordinator.
enum GeoMath {
    /// Total length in meters of a polyline, summing the great-circle distance
    /// between consecutive coordinates.
    static func length(_ coords: [CLLocationCoordinate2D]) -> Double {
        guard coords.count >= 2 else { return 0 }
        var total = 0.0
        for i in 1..<coords.count {
            let a = CLLocation(latitude: coords[i - 1].latitude, longitude: coords[i - 1].longitude)
            let b = CLLocation(latitude: coords[i].latitude, longitude: coords[i].longitude)
            total += b.distance(from: a)
        }
        return total
    }

    /// Index of the vertex in `coords` closest to `target` (great-circle).
    /// Used to order drag-to-reshape via points: since the current route passes
    /// through existing vias in order, a new via's nearest-vertex index tells us
    /// where in the ordered via list it belongs.
    static func nearestIndex(of target: CLLocationCoordinate2D, in coords: [CLLocationCoordinate2D]) -> Int {
        guard !coords.isEmpty else { return 0 }
        let t = CLLocation(latitude: target.latitude, longitude: target.longitude)
        var bestIndex = 0
        var best = Double.greatestFiniteMagnitude
        for (i, c) in coords.enumerated() {
            let d = CLLocation(latitude: c.latitude, longitude: c.longitude).distance(from: t)
            if d < best { best = d; bestIndex = i }
        }
        return bestIndex
    }
}
