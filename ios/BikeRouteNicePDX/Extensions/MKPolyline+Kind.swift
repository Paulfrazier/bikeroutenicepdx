import MapKit
import UIKit

// Distinct MKPolyline subclasses so the renderer can branch on type rather than
// on a (flaky) title string. Each is styled differently in MapCoordinator.
final class GreenwayPolyline: MKPolyline {}
final class RoutePolyline: MKPolyline {}
final class DraftPolyline: MKPolyline {}

/// A hand-drawn (manual) stretch. Legacy overlay type — Draw strokes now render
/// as the colored route line, so this is no longer drawn; kept for the renderer's
/// exhaustive type switch.
final class ManualPolyline: MKPolyline {}

/// Wide, low-alpha underlay drawn beneath the casing to fake a soft outer glow
/// (MKPolylineRenderer has no real blur), lifting the route off the basemap so
/// it reads as a raised ribbon regardless of the bike-network color beneath.
final class RouteGlowPolyline: MKPolyline {}

/// White underlay drawn beneath the colored route runs so the route always
/// reads as a distinct ribbon on top of the colored bike-network overlay.
final class RouteCasingPolyline: MKPolyline {}

/// The resolved street highlight shown while picking a "route through a section"
/// (corridor) — a teal line over a white casing, mirroring the web preview.
final class CorridorPolyline: MKPolyline {}

/// White casing drawn beneath the teal `CorridorPolyline` so the highlighted
/// section reads clearly over the colored bike-network overlay.
final class CorridorCasingPolyline: MKPolyline {}

/// A persistent "your fix" connector (personal or community map-fix), rendered in
/// teal (#0d9488). Drawn as a soft glow underlay + a solid teal line so the fix
/// reads as a distinct, always-on layer beneath the planned route.
final class ConnectorPolyline: MKPolyline {}
/// Wide, low-alpha teal underlay faking a soft glow under `ConnectorPolyline`
/// (MKPolylineRenderer has no real blur), lifting the fix off the basemap.
final class ConnectorGlowPolyline: MKPolyline {}

/// The in-progress connector being built by tapping nodes (tap-to-add). Rendered
/// as a dashed teal line so it reads as a draft distinct from the saved (solid)
/// `ConnectorPolyline` fixes already on the map.
final class ConnectorDraftPolyline: MKPolyline {}

/// One contiguous same-class run of the routed line. The route is rendered as a
/// sequence of these so its color matches the bike-map legend along its length.
final class RouteTierPolyline: MKPolyline {
    var routeClass: RouteClass = .quiet
}

/// One overlay per bike-facility class — all same-class segments are bundled
/// into a single MKMultiPolyline so the whole network renders as ~6 overlays
/// instead of thousands. `bikeClass` drives the renderer's color/width.
final class BikeMultiPolyline: MKMultiPolyline {
    var bikeClass: BikeClass = .lane
}

/// Display categories for the City of Portland Bicycle Network, matching the
/// `class`/`rclass` values in bike-network.geojson. Colors are kept in sync
/// with the web map legend. `busy` is a baked render class (not a physical
/// facility): an unprotected lane along a fast (≥40 mph) street — rendered
/// red dashed, consistent with the route's `.busy` class.
enum BikeClass: String, CaseIterable {
    case greenway
    case `protected`
    case buffered
    case lane
    /// Painted lane on a stressful street — baked into `rclass` when a plain lane
    /// runs along an arterial (or a buffered/sharrow lane on a 4+ lane stroad),
    /// graded by the road's OSM `lanes`: caution2 (≤2 lanes) · caution3 (3) ·
    /// caution4 (4+). Still a lane, so rendered solid orange (darker as the road
    /// widens) — a step short of the red `busy` danger signal.
    case caution2
    case caution3
    case caution4
    case path
    case shared
    /// Fast unprotected lane — baked into `rclass` in the data when a lane/
    /// buffered/shared facility runs along a ≥40 mph street. Not a separate
    /// physical facility; rendered red dashed.
    case busy

    /// Human-readable legend label.
    var label: String {
        switch self {
        case .greenway: return "Neighborhood Greenway"
        case .protected: return "Protected Bike Lane"
        case .buffered: return "Buffered Bike Lane"
        case .lane: return "Bike Lane"
        case .caution2: return "Bike Lane · 2-lane arterial"
        case .caution3: return "Bike Lane · 3-lane arterial"
        case .caution4: return "Bike Lane · 4+ lane arterial"
        case .path: return "Off-Street Path"
        case .shared: return "Enhanced Shared Roadway"
        case .busy: return "Fast Unprotected Lane"
        }
    }

    /// Stroke color (matches web palette + RouteClass colors).
    var color: UIColor {
        switch self {
        case .greenway: return UIColor(red: 0.180, green: 0.620, blue: 0.282, alpha: 1) // #2E9E48
        case .protected: return UIColor(red: 0.427, green: 0.157, blue: 0.851, alpha: 1) // #6D28D9
        case .buffered: return UIColor(red: 0.031, green: 0.569, blue: 0.698, alpha: 1) // #0891B2
        case .lane: return UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1) // #F59E0B
        case .caution2: return UIColor(red: 0.984, green: 0.573, blue: 0.235, alpha: 1) // #FB923C
        case .caution3: return UIColor(red: 0.918, green: 0.345, blue: 0.047, alpha: 1) // #EA580C
        case .caution4: return UIColor(red: 0.604, green: 0.204, blue: 0.071, alpha: 1) // #9A3412
        case .path: return UIColor(red: 0.706, green: 0.325, blue: 0.035, alpha: 1) // #B45309
        case .shared: return UIColor(red: 0.612, green: 0.639, blue: 0.686, alpha: 1) // #9CA3AF
        case .busy: return UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 1) // #DC2626
        }
    }

    var lineWidth: CGFloat {
        switch self {
        case .greenway, .protected, .path: return 4
        case .buffered, .lane, .caution2, .caution3, .caution4, .busy: return 3
        case .shared: return 2.5
        }
    }

    /// Shared roadways and baked-busy lanes both render dashed.
    var dashed: Bool { self == .shared || self == .busy }

    /// Lower draws first (underneath). Higher-quality facilities sit on top.
    /// `busy` renders below `shared` — it is a downgraded lane, not new infra;
    /// `caution` sits just above `shared` (a painted lane, but stressful).
    var zPriority: Int {
        switch self {
        case .busy: return -1
        case .shared: return 0
        case .caution2: return 1
        case .caution3: return 1
        case .caution4: return 1
        case .lane: return 2
        case .path: return 3
        case .buffered: return 4
        case .greenway: return 5
        case .protected: return 6
        }
    }

    /// Order facilities appear in the legend (best/most familiar first).
    /// `busy` is excluded — it is a data-derived render indicator, not a
    /// distinct facility type the legend needs to explain.
    static let legendOrder: [BikeClass] = [.greenway, .protected, .buffered, .lane, .caution2, .caution3, .caution4, .path, .shared]
}

extension MKPolyline {
    /// Materialize the polyline's coordinates into an array.
    var coordinatesArray: [CLLocationCoordinate2D] {
        var coords = [CLLocationCoordinate2D](
            repeating: kCLLocationCoordinate2DInvalid,
            count: pointCount
        )
        getCoordinates(&coords, range: NSRange(location: 0, length: pointCount))
        return coords
    }
}
