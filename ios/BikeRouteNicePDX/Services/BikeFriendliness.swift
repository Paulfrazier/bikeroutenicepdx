import CoreLocation
import UIKit

/// Three-tier bike-friendliness classification for a route line. Each route
/// segment is scored against the bundled City of Portland bike network and
/// bucketed into a traffic-light tier; the line is then colored per tier and a
/// coverage fraction (green+amber over total) is reported.
///
/// Tier colors / labels are kept in sync with the web app's route legend.
enum FriendlyTier: Equatable, Sendable {
    case green   // protected, greenway, path
    case amber   // buffered, lane
    case calm    // no bike facility, but no busy arterial nearby — quiet street
    case red     // no bike facility AND on/along a busy arterial

    /// Stroke color for the route line (matches the web palette).
    var color: UIColor {
        switch self {
        case .green: return UIColor(red: 0.086, green: 0.639, blue: 0.290, alpha: 1) // #16A34A
        case .amber: return UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1) // #F59E0B
        case .calm:  return UIColor(red: 0.392, green: 0.455, blue: 0.545, alpha: 1) // #64748B (slate)
        case .red:   return UIColor(red: 0.863, green: 0.149, blue: 0.149, alpha: 1) // #DC2626
        }
    }

    /// Only busy-street stretches render dashed; calm streets stay solid.
    var dashed: Bool { self == .red }

    /// Map a network facility class onto a friendliness tier. Calm vs red is
    /// never decided here — it's resolved by the arterial fallback when no bike
    /// facility matches, so unrecognized/shared classes fall through to .red and
    /// the arterial check downgrades them to .calm when no busy road is nearby.
    static func tier(forClass cls: String) -> FriendlyTier {
        switch cls {
        case "protected", "greenway", "path": return .green
        case "buffered", "lane": return .amber
        default: return .red // shared (and anything unrecognized)
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

    /// One straight network segment plus precomputed bearing + tier.
    private struct Seg {
        let a: CLLocationCoordinate2D
        let b: CLLocationCoordinate2D
        let bearing: Double
        let tier: FriendlyTier
    }

    /// One straight busy-arterial segment (position + bearing only — no tier;
    /// merely being near one downgrades an otherwise-calm route segment to red).
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

    /// Classify a route line. Returns one tier per route segment
    /// (length == coords.count - 1) and the green+amber coverage fraction.
    func classify(_ coords: [CLLocationCoordinate2D]) -> (tiers: [FriendlyTier], coverage: Double) {
        loadIfNeeded()
        guard coords.count >= 2 else { return ([], 0) }

        let segCount = coords.count - 1
        var rawTiers = [FriendlyTier](repeating: .red, count: segCount)
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
            rawTiers[i] = tierForMidpoint(mid, routeBearing: routeBearing)
        }

        // Hysteresis smoothing → final per-segment tiers.
        let smoothed = smooth(rawTiers, lengths: segLens)

        // Coverage = fraction NOT on a busy road = (total − red length) / total.
        // Green, amber, and calm all count as comfortable.
        var total = 0.0
        var redLength = 0.0
        for i in 0..<segCount {
            total += segLens[i]
            if smoothed[i] == .red { redLength += segLens[i] }
        }
        let coverage = total > 0 ? (total - redLength) / total : 0
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

    /// Tier for a route-segment midpoint. First try to match a nearby bike
    /// facility (green/amber). If none matches, fall back to the arterial index:
    /// on/along a busy road → `.red`, otherwise a quiet street → `.calm`.
    private func tierForMidpoint(_ mid: CLLocationCoordinate2D, routeBearing: Double) -> FriendlyTier {
        let latRad = mid.latitude * .pi / 180
        let cosLat = cos(latRad)

        let cx = Int(floor(mid.longitude / Self.cell))
        let cy = Int(floor(mid.latitude / Self.cell))

        var bestDist = Self.thresholdMeters
        var bestTier: FriendlyTier?
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
                        bestTier = seg.tier
                    }
                }
            }
        }
        if let bestTier { return bestTier }

        // No bike facility — busy arterial nearby → red, else calm quiet street.
        return isOnArterial(mid, routeBearing: routeBearing, cosLat: cosLat, cx: cx, cy: cy)
            ? .red : .calm
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
    /// preceding run's tier. The first run always keeps its own tier.
    private func smooth(_ tiers: [FriendlyTier], lengths: [Double]) -> [FriendlyTier] {
        guard !tiers.isEmpty else { return tiers }

        // Build contiguous runs of equal tier.
        struct Run { var tier: FriendlyTier; var count: Int; var length: Double }
        var runs: [Run] = []
        for i in tiers.indices {
            if var last = runs.last, last.tier == tiers[i] {
                last.count += 1
                last.length += lengths[i]
                runs[runs.count - 1] = last
            } else {
                runs.append(Run(tier: tiers[i], count: 1, length: lengths[i]))
            }
        }

        // Absorb short runs (and re-merge when neighbors end up the same tier).
        var merged: [Run] = []
        for (i, run) in runs.enumerated() {
            if i == 0 {
                merged.append(run)
            } else if run.length < Self.minRunMeters {
                merged[merged.count - 1].count += run.count
                merged[merged.count - 1].length += run.length
            } else if var last = merged.last, last.tier == run.tier {
                last.count += run.count
                last.length += run.length
                merged[merged.count - 1] = last
            } else {
                merged.append(run)
            }
        }

        // Expand back to one tier per segment.
        var out: [FriendlyTier] = []
        out.reserveCapacity(tiers.count)
        for run in merged {
            out.append(contentsOf: repeatElement(run.tier, count: run.count))
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

            let cls = (feature["properties"] as? [String: Any])?["class"] as? String ?? ""
            let tier = FriendlyTier.tier(forClass: cls)

            switch type {
            case "LineString":
                if let line = geometry["coordinates"] as? [[Double]] {
                    addLine(line, tier: tier)
                }
            case "MultiLineString":
                if let lines = geometry["coordinates"] as? [[[Double]]] {
                    for line in lines { addLine(line, tier: tier) }
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
    private func addLine(_ line: [[Double]], tier: FriendlyTier) {
        guard line.count >= 2 else { return }
        var prev: CLLocationCoordinate2D?
        for pair in line {
            guard pair.count >= 2 else { prev = nil; continue }
            let c = CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
            if let a = prev {
                index(Seg(a: a, b: c, bearing: Self.bearing(a, c), tier: tier))
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
