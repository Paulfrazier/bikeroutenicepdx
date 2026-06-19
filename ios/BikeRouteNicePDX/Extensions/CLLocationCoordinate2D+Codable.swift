import CoreLocation

// CLLocationCoordinate2D is a plain C struct with no Equatable conformance.
// Our model structs (Waypoint, SnappedRoute) need equality, so add one with a
// small epsilon. `@retroactive` is required under Swift 6 because neither the
// type nor the protocol is ours.
extension CLLocationCoordinate2D: @retroactive Equatable {
    public static func == (lhs: CLLocationCoordinate2D, rhs: CLLocationCoordinate2D) -> Bool {
        abs(lhs.latitude - rhs.latitude) < 1e-7 && abs(lhs.longitude - rhs.longitude) < 1e-7
    }
}
