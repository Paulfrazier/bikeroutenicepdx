import CoreLocation

/// A snapped route returned by /match.
struct SnappedRoute: Equatable {
    var coordinates: [CLLocationCoordinate2D]
    var distanceMeters: Double

    /// Per-route-segment bike-friendliness tier (length == coordinates.count - 1).
    /// Nil until the route has been classified (e.g. during a drag preview).
    var tiers: [FriendlyTier]? = nil

    /// Fraction of the route length on bike infrastructure (green + amber).
    var coverage: Double? = nil

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
