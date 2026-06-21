import CoreLocation
import UIKit

/// Classification of a route line to MATCH the bike-map legend. Each route
/// segment is scored against the bundled City of Portland bike network and
/// tagged with the facility CLASS it runs on (so the route is drawn in the same
/// colors as the network overlay); off-network segments fall back to `quiet` or
/// the `busy` danger signal. A coverage fraction (everything but `busy` over
/// total) is reported.
///
/// Mirrors the web `RouteClass` (ROUTE_CLASS_COLORS) — colors / cases are kept
/// in lockstep; the parity guard (scripts/check-parity.ts) compares them.
enum RouteClass: String, Equatable, Sendable {
    case protected
    case greenway
    case path
    case buffered
    case lane
    case shared
    case quiet   // off-network, no busy arterial nearby — a calm street
    case busy    // off-network AND on/along a busy arterial — the danger signal

    /// Stroke color for the route line (matches the web ROUTE_CLASS_COLORS, and
    /// the six facility colors equal BikeClass so route + overlay share a key).
    var color: UIColor {
        switch self {
        case .protected: return UIColor(red: 0.427, green: 0.157, blue: 0.851, alpha: 1) // #6D28D9
        case .greenway:  return UIColor(red: 0.180, green: 0.620, blue: 0.282, alpha: 1) // #2E9E48
        case .path:      return UIColor(red: 0.706, green: 0.325, blue: 0.035, alpha: 1) // #B45309
        case .buffered:  return UIColor(red: 0.031, green: 0.569, blue: 0.698, alpha: 1) // #0891B2
        case .lane:      return UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1) // #F59E0B
        case .shared:    return UIColor(red: 0.612, green: 0.639, blue: 0.686, alpha: 1) // #9CA3AF
        case .quiet:     return UIColor(red: 0.392, green: 0.455, blue: 0.545, alpha: 1) // #64748B
        case .busy:      return UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 1) // #DC2626
        }
    }

    /// Shared roadways mirror the overlay's dashed style; busy is the dashed
    /// danger signal. Everything else renders solid.
    var dashed: Bool { self == .shared || self == .busy }

    /// Normalize a raw bike-network `class` value to a known facility class.
    /// Off-network "quiet" vs "busy" is never decided here — it's resolved by the
    /// arterial fallback when no facility matches.
    static func facility(forClass cls: String) -> RouteClass {
        switch cls {
        case "protected": return .protected
        case "greenway": return .greenway
        case "path": return .path
        case "buffered": return .buffered
        case "lane": return .lane
        case "shared": return .shared
        default: return .shared // anything unrecognized
        }
    }
}

/// Lazy-loads + spatially indexes the bundled bike-network.geojson once, then
/// classifies arbitrary route lines against it. An `actor` so the one-time
/// parse + index build happen off the main thread; `classify` is `await`-ed
/// from the (already async) routing paths in `RouteStore`.
actor BikeFriendliness {
    static let shared = BikeFriendliness()

    // MARK: - Tunable constants (must match the web app)

    /// Spatial-hash cell size in degrees (~33 m at Portland's latitude).
    private static let cell = 0.0003
    /// Max perpendicular distance (meters) for a route segment to "match" a
    /// network segment.
    private static let thresholdMeters = 20.0
    /// Max angular difference (degrees, undirected) between the route segment
    /// and a candidate network segment for it to count.
    private static let bearingToleranceDeg = 35.0
    /// Max perpendicular distance (meters) for a route segment to count as being
    /// "on" a busy arterial (tighter than the bike threshold).
    private static let arterialThresholdMeters = 18.0
    /// Max angular difference (degrees, undirected) for a route segment to count
    /// as aligned with a candidate arterial segment.
    private static let arterialBearingToleranceDeg = 30.0
    /// Contiguous tier runs shorter than this (meters) are merged into the
    /// preceding run to kill single-segment color flicker.
    private static let minRunMeters = 25.0

    // MARK: - Index storage

    /// One straight network segment plus precomputed bearing + facility class.
    private struct Seg {
        let a: CLLocationCoordinate2D
        let b: CLLocationCoordinate2D
        let bearing: Double
        let cls: RouteClass
    }

    /// One straight busy-arterial segment (position + bearing only — no class;
    /// merely being near one marks an otherwise-quiet route segment as busy).
    private struct ArtSeg {
        let a: CLLocationCoordinate2D
        let b: CLLocationCoordinate2D
        let bearing: Double
    }

    private struct CellKey: Hashable {
        let x: Int
        let y: Int
    }

    private var segs: [Seg] = []
    private var grid: [CellKey: [Int]] = [:]
    private var artSegs: [ArtSeg] = []
    private var artGrid: [CellKey: [Int]] = [:]
    private var loaded = false

    // MARK: - Public API

    /// Classify a route line. Returns one class per route segment
    /// (length == coords.count - 1) and the comfort-coverage fraction.
    func classify(_ coords: [CLLocationCoordinate2D]) -> (classes: [RouteClass], coverage: Double) {
        loadIfNeeded()
        guard coords.count >= 2 else { return ([], 0) }

        let segCount = coords.count - 1
        var rawClasses = [RouteClass](repeating: .busy, count: segCount)
        var segLens = [Double](repeating: 0, count: segCount)

        for i in 0..<segCount {
            let a = coords[i]
            let b = coords[i + 1]
            segLens[i] = distanceMeters(a, b)

            let mid = CLLocationCoordinate2D(
                latitude: (a.latitude + b.latitude) / 2,
                longitude: (a.longitude + b.longitude) / 2
            )
            let routeBearing = Self.bearing(a, b)
            rawClasses[i] = classForMidpoint(mid, routeBearing: routeBearing)
        }

        // Hysteresis smoothing → final per-segment classes.
        let smoothed = smooth(rawClasses, lengths: segLens)

        // Coverage = fraction NOT on a busy no-facility road = (total − busy) /
        // total. Every facility class and a quiet street count as comfortable.
        var total = 0.0
        var busyLength = 0.0
        for i in 0..<segCount {
            total += segLens[i]
            if smoothed[i] == .busy { busyLength += segLens[i] }
        }
        let coverage = total > 0 ? (total - busyLength) / total : 0
        return (smoothed, coverage)
    }

    /// Snap `target` onto the nearest bike-network edge, returned in lat/lng.
    /// Returns nil when no segment lies within `maxMeters` (the caller keeps the
    /// raw point so off-network drags still route). Snaps to ANY facility tier —
    /// we want the dragged waypoint on a real path, not necessarily a greenway —
    /// so the re-route doesn't take weird detours from a mid-block via.
    func nearestNetworkPoint(
        _ target: CLLocationCoordinate2D,
        // Generous by default: a NORMAL drag should always land on a real
        // bikeable street near the finger (route bulges locally, never flies off
        // to a far node). Precise anchors never call this — they stay exact.
        maxMeters: Double = 100
    ) -> CLLocationCoordinate2D? {
        loadIfNeeded()
        let cosLat = cos(target.latitude * .pi / 180)
        let cx = Int(floor(target.longitude / Self.cell))
        let cy = Int(floor(target.latitude / Self.cell))
        // Cell ≈ 33 m; widen the search neighborhood to cover maxMeters.
        let reach = max(1, Int(ceil(maxMeters / (Self.cell * 110_540))))

        var bestDist = maxMeters
        var best: CLLocationCoordinate2D?
        var seen = Set<Int>()
        for gx in (cx - reach)...(cx + reach) {
            for gy in (cy - reach)...(cy + reach) {
                guard let bucket = grid[CellKey(x: gx, y: gy)] else { continue }
                for idx in bucket {
                    if !seen.insert(idx).inserted { continue }
                    let seg = segs[idx]
                    let pt = closestPointMeters(target: target, a: seg.a, b: seg.b, cosLat: cosLat)
                    let d = distanceMeters(target, pt)
                    if d < bestDist { bestDist = d; best = pt }
                }
            }
        }
        return best
    }

    // MARK: - Classification core

    /// Facility class for a route-segment midpoint. First try to match a nearby
    /// bike facility and adopt its class. If none matches, fall back to the
    /// arterial index: on/along a busy road → `.busy`, otherwise → `.quiet`.
    private func classForMidpoint(_ mid: CLLocationCoordinate2D, routeBearing: Double) -> RouteClass {
        let latRad = mid.latitude * .pi / 180
        let cosLat = cos(latRad)

        let cx = Int(floor(mid.longitude / Self.cell))
        let cy = Int(floor(mid.latitude / Self.cell))

        var bestDist = Self.thresholdMeters
        var bestClass: RouteClass?
        var seen = Set<Int>()

        for gx in (cx - 1)...(cx + 1) {
            for gy in (cy - 1)...(cy + 1) {
                guard let bucket = grid[CellKey(x: gx, y: gy)] else { continue }
                for idx in bucket {
                    if !seen.insert(idx).inserted { continue }
                    let seg = segs[idx]

                    // Bearing alignment (undirected, folded to 0...90).
                    if Self.angularDelta(routeBearing, seg.bearing) > Self.bearingToleranceDeg {
                        continue
                    }

                    let d = perpDistanceMeters(
                        mid: mid, a: seg.a, b: seg.b, cosLat: cosLat
                    )
                    if d <= bestDist {
                        bestDist = d
                        bestClass = seg.cls
                    }
                }
            }
        }
        if let bestClass { return bestClass }

        // No bike facility — busy arterial nearby → danger, else quiet street.
        return isOnArterial(mid, routeBearing: routeBearing, cosLat: cosLat, cx: cx, cy: cy)
            ? .busy : .quiet
    }

    /// Whether the midpoint is within `arterialThresholdMeters` of a busy
    /// arterial segment that is bearing-aligned within `arterialBearingToleranceDeg`.
    private func isOnArterial(
        _ mid: CLLocationCoordinate2D,
        routeBearing: Double,
        cosLat: Double,
        cx: Int,
        cy: Int
    ) -> Bool {
        var seen = Set<Int>()
        for gx in (cx - 1)...(cx + 1) {
            for gy in (cy - 1)...(cy + 1) {
                guard let bucket = artGrid[CellKey(x: gx, y: gy)] else { continue }
                for idx in bucket {
                    if !seen.insert(idx).inserted { continue }
                    let seg = artSegs[idx]
                    if Self.angularDelta(routeBearing, seg.bearing) > Self.arterialBearingToleranceDeg {
                        continue
                    }
                    let d = perpDistanceMeters(
                        mid: mid, a: seg.a, b: seg.b, cosLat: cosLat
                    )
                    if d <= Self.arterialThresholdMeters { return true }
                }
            }
        }
        return false
    }

    /// Merge contiguous runs whose total length < minRunMeters into the
    /// preceding run's class. The first run always keeps its own class.
    private func smooth(_ classes: [RouteClass], lengths: [Double]) -> [RouteClass] {
        guard !classes.isEmpty else { return classes }

        // Build contiguous runs of equal class.
        struct Run { var cls: RouteClass; var count: Int; var length: Double }
        var runs: [Run] = []
        for i in classes.indices {
            if var last = runs.last, last.cls == classes[i] {
                last.count += 1
                last.length += lengths[i]
                runs[runs.count - 1] = last
            } else {
                runs.append(Run(cls: classes[i], count: 1, length: lengths[i]))
            }
        }

        // Absorb short runs (and re-merge when neighbors end up the same class).
        var merged: [Run] = []
        for (i, run) in runs.enumerated() {
            if i == 0 {
                merged.append(run)
            } else if run.length < Self.minRunMeters {
                merged[merged.count - 1].count += run.count
                merged[merged.count - 1].length += run.length
            } else if var last = merged.last, last.cls == run.cls {
                last.count += run.count
                last.length += run.length
                merged[merged.count - 1] = last
            } else {
                merged.append(run)
            }
        }

        // Expand back to one class per segment.
        var out: [RouteClass] = []
        out.reserveCapacity(classes.count)
        for run in merged {
            out.append(contentsOf: repeatElement(run.cls, count: run.count))
        }
        return out
    }

    // MARK: - Index building

    private func loadIfNeeded() {
        guard !loaded else { return }
        loaded = true

        guard
            let url = Bundle.main.url(forResource: "bike-network", withExtension: "geojson"),
            let data = try? Data(contentsOf: url),
            // Use JSONSerialization, NOT MKGeoJSONDecoder: the latter fails the
            // whole FeatureCollection on a single degenerate feature.
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let features = root["features"] as? [[String: Any]]
        else {
            return
        }

        for feature in features {
            guard
                let geometry = feature["geometry"] as? [String: Any],
                let type = geometry["type"] as? String
            else { continue }

            let rawCls = (feature["properties"] as? [String: Any])?["class"] as? String ?? ""
            let cls = RouteClass.facility(forClass: rawCls)

            switch type {
            case "LineString":
                if let line = geometry["coordinates"] as? [[Double]] {
                    addLine(line, cls: cls)
                }
            case "MultiLineString":
                if let lines = geometry["coordinates"] as? [[[Double]]] {
                    for line in lines { addLine(line, cls: cls) }
                }
            default:
                continue
            }
        }

        loadArterials()
    }

    /// Build the second spatial index over the bundled busy-arterial network.
    /// Same grid cell size + helpers as the bike index; segments carry bearing +
    /// position only (no tier).
    private func loadArterials() {
        guard
            let url = Bundle.main.url(forResource: "arterials", withExtension: "geojson"),
            let data = try? Data(contentsOf: url),
            // JSONSerialization (not MKGeoJSONDecoder) — one bad feature must not
            // nuke the whole collection.
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let features = root["features"] as? [[String: Any]]
        else {
            return
        }

        for feature in features {
            guard
                let geometry = feature["geometry"] as? [String: Any],
                let type = geometry["type"] as? String
            else { continue }

            switch type {
            case "LineString":
                if let line = geometry["coordinates"] as? [[Double]] {
                    addArterialLine(line)
                }
            case "MultiLineString":
                if let lines = geometry["coordinates"] as? [[[Double]]] {
                    for line in lines { addArterialLine(line) }
                }
            default:
                continue
            }
        }
    }

    /// Split one [[lng, lat], ...] arterial line into straight segments + index.
    private func addArterialLine(_ line: [[Double]]) {
        guard line.count >= 2 else { return }
        var prev: CLLocationCoordinate2D?
        for pair in line {
            guard pair.count >= 2 else { prev = nil; continue }
            let c = CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
            if let a = prev {
                indexArterial(ArtSeg(a: a, b: c, bearing: Self.bearing(a, c)))
            }
            prev = c
        }
    }

    /// Add an arterial segment to every grid cell its bounding box touches.
    private func indexArterial(_ seg: ArtSeg) {
        let idx = artSegs.count
        artSegs.append(seg)

        let minLng = min(seg.a.longitude, seg.b.longitude)
        let maxLng = max(seg.a.longitude, seg.b.longitude)
        let minLat = min(seg.a.latitude, seg.b.latitude)
        let maxLat = max(seg.a.latitude, seg.b.latitude)

        let x0 = Int(floor(minLng / Self.cell))
        let x1 = Int(floor(maxLng / Self.cell))
        let y0 = Int(floor(minLat / Self.cell))
        let y1 = Int(floor(maxLat / Self.cell))

        for gx in x0...x1 {
            for gy in y0...y1 {
                artGrid[CellKey(x: gx, y: gy), default: []].append(idx)
            }
        }
    }

    /// Split one [[lng, lat], ...] line into straight segments and index each.
    private func addLine(_ line: [[Double]], cls: RouteClass) {
        guard line.count >= 2 else { return }
        var prev: CLLocationCoordinate2D?
        for pair in line {
            guard pair.count >= 2 else { prev = nil; continue }
            let c = CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
            if let a = prev {
                index(Seg(a: a, b: c, bearing: Self.bearing(a, c), cls: cls))
            }
            prev = c
        }
    }

    /// Add a segment to every grid cell its bounding box touches.
    private func index(_ seg: Seg) {
        let idx = segs.count
        segs.append(seg)

        let minLng = min(seg.a.longitude, seg.b.longitude)
        let maxLng = max(seg.a.longitude, seg.b.longitude)
        let minLat = min(seg.a.latitude, seg.b.latitude)
        let maxLat = max(seg.a.latitude, seg.b.latitude)

        let x0 = Int(floor(minLng / Self.cell))
        let x1 = Int(floor(maxLng / Self.cell))
        let y0 = Int(floor(minLat / Self.cell))
        let y1 = Int(floor(maxLat / Self.cell))

        for gx in x0...x1 {
            for gy in y0...y1 {
                grid[CellKey(x: gx, y: gy), default: []].append(idx)
            }
        }
    }

    // MARK: - Geometry helpers

    /// Great-circle distance in meters between two coordinates.
    private func distanceMeters(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        CLLocation(latitude: a.latitude, longitude: a.longitude)
            .distance(from: CLLocation(latitude: b.latitude, longitude: b.longitude))
    }

    /// Perpendicular distance (meters) from `mid` to segment a→b using a local
    /// equirectangular projection centered on `mid`.
    private func perpDistanceMeters(
        mid: CLLocationCoordinate2D,
        a: CLLocationCoordinate2D,
        b: CLLocationCoordinate2D,
        cosLat: Double
    ) -> Double {
        func project(_ c: CLLocationCoordinate2D) -> (x: Double, y: Double) {
            let dx = (c.longitude - mid.longitude) * cosLat * 111_320
            let dy = (c.latitude - mid.latitude) * 110_540
            return (dx, dy)
        }
        let pa = project(a)
        let pb = project(b)
        // mid projects to the origin.
        let dx = pb.x - pa.x
        let dy = pb.y - pa.y
        let lenSq = dx * dx + dy * dy
        if lenSq == 0 { return hypot(pa.x, pa.y) }
        var t = (-pa.x * dx - pa.y * dy) / lenSq
        t = max(0, min(1, t))
        let projX = pa.x + t * dx
        let projY = pa.y + t * dy
        return hypot(projX, projY)
    }

    /// Closest point to `target` on segment a→b, returned in lat/lng, via a
    /// local equirectangular projection centered on `target` (the lat/lng
    /// companion to `perpDistanceMeters`, which returns only the distance).
    private func closestPointMeters(
        target: CLLocationCoordinate2D,
        a: CLLocationCoordinate2D,
        b: CLLocationCoordinate2D,
        cosLat: Double
    ) -> CLLocationCoordinate2D {
        func project(_ c: CLLocationCoordinate2D) -> (x: Double, y: Double) {
            let dx = (c.longitude - target.longitude) * cosLat * 111_320
            let dy = (c.latitude - target.latitude) * 110_540
            return (dx, dy)
        }
        let pa = project(a)
        let pb = project(b)
        // target projects to the origin.
        let dx = pb.x - pa.x
        let dy = pb.y - pa.y
        let lenSq = dx * dx + dy * dy
        let projX: Double
        let projY: Double
        if lenSq == 0 {
            projX = pa.x
            projY = pa.y
        } else {
            var t = (-pa.x * dx - pa.y * dy) / lenSq
            t = max(0, min(1, t))
            projX = pa.x + t * dx
            projY = pa.y + t * dy
        }
        // Unproject back to lat/lng.
        return CLLocationCoordinate2D(
            latitude: target.latitude + projY / 110_540,
            longitude: target.longitude + projX / (cosLat * 111_320)
        )
    }

    /// Initial bearing a→b, degrees in 0..<360.
    private static func bearing(_ a: CLLocationCoordinate2D, _ b: CLLocationCoordinate2D) -> Double {
        let lat1 = a.latitude * .pi / 180
        let lat2 = b.latitude * .pi / 180
        let dLng = (b.longitude - a.longitude) * .pi / 180
        let y = sin(dLng) * cos(lat2)
        let x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
        let deg = atan2(y, x) * 180 / .pi
        return deg.truncatingRemainder(dividingBy: 360) + (deg < 0 ? 360 : 0)
    }

    /// Undirected angular difference between two bearings, folded to 0...90°
    /// (so opposite directions along the same line read as aligned).
    private static func angularDelta(_ b1: Double, _ b2: Double) -> Double {
        var d = abs(b1 - b2).truncatingRemainder(dividingBy: 180)
        if d > 90 { d = 180 - d }
        return d
    }
}
