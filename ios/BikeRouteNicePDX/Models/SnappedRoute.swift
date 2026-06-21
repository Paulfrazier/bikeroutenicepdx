import CoreLocation

/// A snapped route returned by /match.
struct SnappedRoute: Equatable {
    var coordinates: [CLLocationCoordinate2D]
    var distanceMeters: Double

    /// Estimated travel time in seconds, from the routing engine. 0 for
    /// drag-preview routes built client-side before a server round-trip.
    var durationSeconds: Double = 0

    /// Per-route-segment facility class (length == coordinates.count - 1).
    /// Nil until the route has been classified (e.g. during a drag preview).
    var routeClasses: [RouteClass]? = nil

    /// Fraction of the route length NOT on a busy no-facility street.
    var coverage: Double? = nil

    /// Turn-by-turn directions from /route (empty for /match-snapped routes).
    var steps: [RouteStep] = []

    /// Human-readable distance, imperial (Portland).
    var distanceLabel: String {
        let miles = distanceMeters / 1609.344
        if miles < 0.1 {
            let feet = Int((distanceMeters * 3.28084).rounded())
            return "\(feet) ft"
        }
        return String(format: "%.1f mi", miles)
    }

    /// Human-readable estimated travel time (e.g. "~18 min", "~1 h 5 min").
    /// Empty while no estimate is available (drag previews).
    var durationLabel: String {
        guard durationSeconds > 0 else { return "" }
        let min = Int((durationSeconds / 60).rounded())
        if min < 60 { return "~\(min) min" }
        let h = min / 60
        let rem = min % 60
        return rem > 0 ? "~\(h) h \(rem) min" : "~\(h) h"
    }
}
