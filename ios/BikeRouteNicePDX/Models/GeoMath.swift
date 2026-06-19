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
}
