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

    /// Great-circle distance (m) between two coordinates.
    static func distance(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude)
            .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    /// Closest point to `p` on the lat/lng segment a→b, via a local
    /// equirectangular projection centered on `p`.
    static func closestPointOnSegment(
        _ p: CLLocationCoordinate2D,
        _ a: CLLocationCoordinate2D,
        _ b: CLLocationCoordinate2D
    ) -> CLLocationCoordinate2D {
        let cosLat = cos(p.latitude * .pi / 180)
        func proj(_ c: CLLocationCoordinate2D) -> (x: Double, y: Double) {
            ((c.longitude - p.longitude) * cosLat * 111_320, (c.latitude - p.latitude) * 110_540)
        }
        let pa = proj(a)
        let pb = proj(b)
        let dx = pb.x - pa.x
        let dy = pb.y - pa.y
        let lenSq = dx * dx + dy * dy
        let cx: Double
        let cy: Double
        if lenSq == 0 {
            cx = pa.x; cy = pa.y
        } else {
            var t = (-pa.x * dx - pa.y * dy) / lenSq
            t = max(0, min(1, t))
            cx = pa.x + t * dx
            cy = pa.y + t * dy
        }
        return CLLocationCoordinate2D(
            latitude: p.latitude + cy / 110_540,
            longitude: p.longitude + cx / (cosLat * 111_320)
        )
    }

    /// Position of `target` ALONG `coords` as cumulative meters to its closest
    /// projection. Monotonic — unlike `nearestIndex` it can't invert when the
    /// route re-snaps, giving stable waypoint ordering.
    static func arcLength(of target: CLLocationCoordinate2D, in coords: [CLLocationCoordinate2D]) -> Double {
        guard coords.count >= 2 else { return 0 }
        var cumulative = 0.0
        var bestDist = Double.greatestFiniteMagnitude
        var bestArc = 0.0
        for i in 0..<(coords.count - 1) {
            let a = coords[i]
            let b = coords[i + 1]
            let projPt = closestPointOnSegment(target, a, b)
            let d = distance(target, projPt)
            if d < bestDist {
                bestDist = d
                bestArc = cumulative + distance(a, projPt)
            }
            cumulative += distance(a, b)
        }
        return bestArc
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
