import MapKit
import UIKit

// Distinct MKPolyline subclasses so the renderer can branch on type rather than
// on a (flaky) title string. Each is styled differently in MapCoordinator.
final class GreenwayPolyline: MKPolyline {}
final class RoutePolyline: MKPolyline {}
final class DraftPolyline: MKPolyline {}

/// A hand-drawn (manual) stretch, overlaid in a distinct dashed violet so it's
/// clear which part of the route is forced verbatim vs. routed.
final class ManualPolyline: MKPolyline {}

/// Wide, low-alpha underlay drawn beneath the casing to fake a soft outer glow
/// (MKPolylineRenderer has no real blur), lifting the route off the basemap so
/// it reads as a raised ribbon regardless of the bike-network color beneath.
final class RouteGlowPolyline: MKPolyline {}

/// White underlay drawn beneath the colored route runs so the route always
/// reads as a distinct ribbon on top of the colored bike-network overlay.
final class RouteCasingPolyline: MKPolyline {}

/// One contiguous same-tier run of the routed line. The route is rendered as a
/// sequence of these so its color tracks bike-friendliness along its length.
final class RouteTierPolyline: MKPolyline {
    var tier: FriendlyTier = .green
}

/// One overlay per bike-facility class — all same-class segments are bundled
/// into a single MKMultiPolyline so the whole network renders as ~6 overlays
/// instead of thousands. `bikeClass` drives the renderer's color/width.
final class BikeMultiPolyline: MKMultiPolyline {
    var bikeClass: BikeClass = .lane
}

/// Display categories for the City of Portland Bicycle Network, matching the
/// `class` values produced by `scripts/export-bike-network.ts`. Colors are kept
/// in sync with the web map legend.
enum BikeClass: String, CaseIterable {
    case greenway
    case `protected`
    case buffered
    case lane
    case path
    case shared

    /// Human-readable legend label.
    var label: String {
        switch self {
        case .greenway: return "Neighborhood Greenway"
        case .protected: return "Protected Bike Lane"
        case .buffered: return "Buffered Bike Lane"
        case .lane: return "Bike Lane"
        case .path: return "Off-Street Path"
        case .shared: return "Enhanced Shared Roadway"
        }
    }

    /// Stroke color (matches web palette).
    var color: UIColor {
        switch self {
        case .greenway: return UIColor(red: 0.180, green: 0.620, blue: 0.282, alpha: 1) // #2E9E48
        case .protected: return UIColor(red: 0.427, green: 0.157, blue: 0.851, alpha: 1) // #6D28D9
        case .buffered: return UIColor(red: 0.031, green: 0.569, blue: 0.698, alpha: 1) // #0891B2
        case .lane: return UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1) // #F59E0B
        case .path: return UIColor(red: 0.706, green: 0.325, blue: 0.035, alpha: 1) // #B45309
        case .shared: return UIColor(red: 0.612, green: 0.639, blue: 0.686, alpha: 1) // #9CA3AF
        }
    }

    var lineWidth: CGFloat {
        switch self {
        case .greenway, .protected, .path: return 4
        case .buffered, .lane: return 3
        case .shared: return 2.5
        }
    }

    var dashed: Bool { self == .shared }

    /// Lower draws first (underneath). Higher-quality facilities sit on top.
    var zPriority: Int {
        switch self {
        case .shared: return 0
        case .lane: return 1
        case .path: return 2
        case .buffered: return 3
        case .greenway: return 4
        case .protected: return 5
        }
    }

    /// Order facilities appear in the legend (best/most familiar first).
    static let legendOrder: [BikeClass] = [.greenway, .protected, .buffered, .lane, .path, .shared]
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
