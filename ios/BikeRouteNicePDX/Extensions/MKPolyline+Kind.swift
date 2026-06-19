import MapKit

// Distinct MKPolyline subclasses so the renderer can branch on type rather than
// on a (flaky) title string. Each is styled differently in MapCoordinator.
final class GreenwayPolyline: MKPolyline {}
final class RoutePolyline: MKPolyline {}
final class DraftPolyline: MKPolyline {}

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
