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

    /// Shortest distance (m) from `target` to the polyline `coords` — the min
    /// over all segments of the distance to the closest point on that segment.
    /// Used by navigation to decide when the rider has gone off-route.
    static func distanceToPolyline(_ target: CLLocationCoordinate2D, _ coords: [CLLocationCoordinate2D]) -> Double {
        guard coords.count >= 2 else {
            return coords.first.map { distance(target, $0) } ?? .greatestFiniteMagnitude
        }
        var best = Double.greatestFiniteMagnitude
        for i in 0..<(coords.count - 1) {
            let proj = closestPointOnSegment(target, coords[i], coords[i + 1])
            best = min(best, distance(target, proj))
        }
        return best
    }

    /// Initial bearing (degrees, 0–360 clockwise from north) from `a` to `b`.
    /// Used to orient the navigation chase camera when GPS course is unavailable.
    static func bearing(from a: CLLocationCoordinate2D, to b: CLLocationCoordinate2D) -> Double {
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let dLon = (b.longitude - a.longitude) * .pi / 180
        let y = sin(dLon) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLon)
        let deg = atan2(y, x) * 180 / .pi
        return (deg + 360).truncatingRemainder(dividingBy: 360)
    }

    /// Coordinate at `meters` along the polyline `coords` from its start, by
    /// walking cumulative segment lengths. Clamps to the last vertex. Used to aim
    /// the chase camera slightly ahead of the rider.
    static func point(at meters: Double, along coords: [CLLocationCoordinate2D]) -> CLLocationCoordinate2D? {
        guard let first = coords.first else { return nil }
        guard coords.count >= 2, meters > 0 else { return first }
        var remaining = meters
        for i in 0..<(coords.count - 1) {
            let segLen = distance(coords[i], coords[i + 1])
            if remaining <= segLen {
                let t = segLen == 0 ? 0 : remaining / segLen
                return CLLocationCoordinate2D(
                    latitude: coords[i].latitude + (coords[i + 1].latitude - coords[i].latitude) * t,
                    longitude: coords[i].longitude + (coords[i + 1].longitude - coords[i].longitude) * t
                )
            }
            remaining -= segLen
        }
        return coords.last
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
