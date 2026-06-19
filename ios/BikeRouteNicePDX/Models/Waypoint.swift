import CoreLocation

enum WaypointKind {
    case start
    case end
}

struct Waypoint: Identifiable, Equatable {
    let id = UUID()
    var coordinate: CLLocationCoordinate2D
    var label: String
    let kind: WaypointKind
}
