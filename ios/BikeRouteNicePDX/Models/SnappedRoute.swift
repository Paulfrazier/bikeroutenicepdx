import CoreLocation

/// A snapped route returned by /match.
struct SnappedRoute: Equatable {
    var coordinates: [CLLocationCoordinate2D]
    var distanceMeters: Double

    /// Human-readable distance, imperial (Portland).
    var distanceLabel: String {
        let miles = distanceMeters / 1609.344
        if miles < 0.1 {
            let feet = Int((distanceMeters * 3.28084).rounded())
            return "\(feet) ft"
        }
        return String(format: "%.1f mi", miles)
    }
}
