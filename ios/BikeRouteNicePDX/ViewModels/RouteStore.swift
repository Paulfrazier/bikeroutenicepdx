import SwiftUI
import CoreLocation

/// A drag-to-reshape waypoint. Unlike the bare coordinate sent to the server it
/// carries a stable `id` (so re-routes never reorder/lose it) and a `precise`
/// flag: precise waypoints are pinned exactly where dropped (never snapped to
/// the network) so the user can force the route through an exact point.
struct Via: Identifiable {
    let id: UUID
    var coordinate: CLLocationCoordinate2D
    var precise: Bool

    init(id: UUID = UUID(), coordinate: CLLocationCoordinate2D, precise: Bool = false) {
        self.id = id
        self.coordinate = coordinate
        self.precise = precise
    }
}

/// A hand-drawn stretch kept VERBATIM and spliced into the auto-route — for
/// forcing a path the router can't take (data gaps: a cycle track tagged as
/// sharrows, a median/crosswalk crossing not in the graph). The auto route
/// handles everything before/after; only this stretch is overridden.
struct ManualSegment: Identifiable {
    let id: UUID
    var coords: [CLLocationCoordinate2D]

    init(id: UUID = UUID(), coords: [CLLocationCoordinate2D]) {
        self.id = id
        self.coords = coords
    }
}

/// Greenway-vs-speed preference for routing. Maps to the server's `use_roads`.
enum RoutePreference: String, CaseIterable, Identifiable {
    case comfort, balanced, fast
    var id: String { rawValue }
    /// Short label for the segmented control.
    var label: String {
        switch self {
        case .comfort: return "Comfort"
        case .balanced: return "Balanced"
        case .fast: return "Fast"
        }
    }
}

/// Single source of truth for the draw-a-route flow. Injected at the app root
/// and read by every view via `@Environment(RouteStore.self)`.
@MainActor
@Observable
final class RouteStore {
    // Pins
    var start: Waypoint?
    var end: Waypoint?

    /// Greenway-vs-speed preference (Comfort↔Fast). Persisted across launches.
    /// Changing it while a route is shown recomputes it.
    var routePreference: RoutePreference = {
        let raw = UserDefaults.standard.string(forKey: "routePreference") ?? RoutePreference.comfort.rawValue
        return RoutePreference(rawValue: raw) ?? .comfort
    }() {
        didSet {
            guard oldValue != routePreference else { return }
            UserDefaults.standard.set(routePreference.rawValue, forKey: "routePreference")
            // Recompute the current route under the new preference.
            if bothPinsSet, !isDrawMode { scheduleAutoRoute() }
        }
    }

    // Draw mode
    var isDrawMode = false
    var drawnTrace: [CLLocationCoordinate2D] = []

    /// Ordered drag-to-reshape waypoints (stable id + precise flag). Each
    /// hand-drag drops/moves one; the route is re-routed start → vias → end.
    /// PERSISTS across endpoint tweaks — only an explicit reset clears them.
    var vias: [Via] = []

    /// Cap on drag-to-reshape waypoints. Generous — complex routes need many.
    static let maxVias = 40

    /// Hand-drawn stretches spliced into the auto route (manual mode). Persist
    /// across endpoint/waypoint edits; cleared only on an explicit reset.
    var manualSegments: [ManualSegment] = []

    /// The raw auto route from the server, BEFORE manual segments are spliced in.
    /// `snapped` is the display geometry = `applyManualSegments(autoRoute, …)`.
    private var autoRoute: SnappedRoute?

    // Result
    var snapped: SnappedRoute? {
        didSet { routeVersion += 1 }
    }
    var phase: RoutePhase = .idle
    var errorMessage: String?

    /// Bumped on every `snapped` assignment so the map coordinator can reliably
    /// detect a route change and rebuild its overlay — even when a re-snap
    /// returns the same number of points as the line it replaces.
    private(set) var routeVersion = 0

    /// True once the user has hand-dragged the route line, overriding the
    /// server snap. Drives the "Manually edited" caption and is reset whenever
    /// a fresh route is started.
    var isManuallyEdited = false

    /// Whether the user has tapped "Edit route" to make the line draggable. When
    /// false the route is non-interactive and the map pans freely over it (no
    /// accidental grabs). Reset whenever a fresh route or new endpoint appears.
    var isEditMode = false

    // Search
    var searchResults: [SearchResult] = []

    // Map controls — incremented to ask the map to recenter on the user's
    // current location (observed by the coordinator in updateUIView).
    private(set) var recenterTick = 0
    func recenterOnUser() { recenterTick += 1 }

    // Bumped to ask the map to set the route START to the user's current
    // location (observed by the coordinator, which has the live GPS fix).
    private(set) var useLocationTick = 0
    func useMyLocationAsStart() { useLocationTick += 1 }

    private let match = MatchService()
    private let router = RouteService()
    private let search = SearchService()

    /// Debounce/cancel token for the auto-route. Cancelling it both aborts the
    /// pending ~350ms delay and flags the in-flight request as stale so a late
    /// network result can't clobber a newer route.
    private var autoRouteTask: Task<Void, Never>?

    var bothPinsSet: Bool { start != nil && end != nil }

    // MARK: - Pins

    func setPin(_ coordinate: CLLocationCoordinate2D, kind: WaypointKind, label: String) {
        let waypoint = Waypoint(coordinate: coordinate, label: label, kind: kind)
        switch kind {
        case .start: start = waypoint
        case .end: end = waypoint
        }
        // Changing a pin invalidates the drawn geometry but KEEPS waypoints — the
        // auto-route re-routes start → vias → end so a careful edit isn't wiped.
        snapped = nil
        isEditMode = false
        searchResults = []
        recomputeIdlePhase()
        scheduleAutoRoute()
    }

    /// Tap on the map (when not drawing): fill start, then end.
    func handleMapTap(_ coordinate: CLLocationCoordinate2D) {
        if start == nil {
            setPin(coordinate, kind: .start, label: "Dropped pin")
        } else if end == nil {
            setPin(coordinate, kind: .end, label: "Dropped pin")
        }
    }

    private func recomputeIdlePhase() {
        if bothPinsSet {
            phase = .readyToDraw
        } else if start == nil {
            phase = start == nil && end == nil ? .idle : .settingStart
        } else {
            phase = .settingEnd
        }
    }

    // MARK: - Auto-route (web parity)

    /// Web parity: the moment both pins exist (and we're not finger-drawing),
    /// auto-compute a clean start → end route. Debounced ~350ms and cancellable
    /// so rapidly setting both pins (e.g. search-then-search) routes only once.
    /// Freehand draw remains available from the routed state.
    func scheduleAutoRoute() {
        autoRouteTask?.cancel()
        guard bothPinsSet, !isDrawMode, let startC = start?.coordinate, let endC = end?.coordinate else {
            return
        }
        // Reflect "working" immediately so the controls don't sit on a stale
        // "Draw route" gate during the debounce window.
        phase = .snapping
        errorMessage = nil
        autoRouteTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 350_000_000)
            if Task.isCancelled { return }
            await self?.performAutoRoute(from: startC, to: endC)
        }
    }

    private func performAutoRoute(from startC: CLLocationCoordinate2D, to endC: CLLocationCoordinate2D) async {
        // Route THROUGH any existing waypoints (they persist across endpoint
        // tweaks) rather than dropping them.
        isManuallyEdited = false
        phase = .snapping
        errorMessage = nil
        do {
            let routed = try await router.route(
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue
            )
            if Task.isCancelled { return }
            guard routed.coordinates.count >= 2 else { throw APIError.transport("empty route") }
            autoRoute = routed
            await recomputeDisplay()
            if Task.isCancelled { return }
            phase = .routed
        } catch {
            if Task.isCancelled { return }
            let message = (error as? APIError)?.errorDescription ?? error.localizedDescription
            errorMessage = message
            phase = .failed(message)
        }
    }

    /// Attach bike-friendliness tiers + coverage to a freshly computed route.
    /// Shared by the auto-route, drag-reshape, and finger-draw success paths.
    private func classified(_ route: SnappedRoute) async -> SnappedRoute {
        let result = await BikeFriendliness.shared.classify(route.coordinates)
        var enriched = route
        enriched.tiers = result.tiers
        enriched.coverage = result.coverage
        return enriched
    }

    // MARK: - Manual-segment splice

    /// Splice each drawn segment into `auto` by nearest-point anchoring: replace
    /// the stretch between the points closest to the segment's ends with the
    /// drawn coords (oriented to match). Segments applied by descending start
    /// index so earlier splices don't shift later ones. Non-overlapping for v1.
    static func applyManualSegments(
        _ auto: [CLLocationCoordinate2D],
        _ segments: [ManualSegment]
    ) -> [CLLocationCoordinate2D] {
        guard !segments.isEmpty, auto.count >= 2 else { return auto }
        let placed: [(i: Int, j: Int, coords: [CLLocationCoordinate2D])] = segments.compactMap { seg in
            guard let first = seg.coords.first, let last = seg.coords.last, seg.coords.count >= 2 else { return nil }
            var i = GeoMath.nearestIndex(of: first, in: auto)
            var j = GeoMath.nearestIndex(of: last, in: auto)
            var c = seg.coords
            if i > j { swap(&i, &j); c.reverse() }
            return (i, j, c)
        }.sorted { $0.i > $1.i }

        var result = auto
        for p in placed {
            let lo = max(0, min(p.i, result.count - 1))
            let hi = max(0, min(p.j, result.count - 1))
            guard lo <= hi else { continue }
            result.replaceSubrange(lo...hi, with: p.coords)
        }
        return result
    }

    /// Rebuild the display route from the auto route + manual segments, classify
    /// it, and publish to `snapped`. No server call.
    private func recomputeDisplay() async {
        guard let auto = autoRoute else { snapped = nil; return }
        let coords = Self.applyManualSegments(auto.coordinates, manualSegments)
        let base = SnappedRoute(coordinates: coords, distanceMeters: GeoMath.length(coords))
        snapped = await classified(base)
    }

    // MARK: - Draw mode

    /// Enter manual-draw mode: a stroke drawn now becomes a ManualSegment spliced
    /// into the current auto route (forcing that stretch). Requires an existing
    /// route to splice into; KEEPS the route visible under the draft.
    func enterDrawMode() {
        autoRouteTask?.cancel()
        guard bothPinsSet, autoRoute != nil else { return }
        isDrawMode = true
        drawnTrace = []
        errorMessage = nil
        phase = .drawing
    }

    /// Clear manual segments (and the drawn trace), keep the auto route + pins.
    func clearDraw() {
        autoRouteTask?.cancel()
        isDrawMode = false
        drawnTrace = []
        manualSegments = []
        errorMessage = nil
        Task { await recomputeDisplay() }
        if autoRoute != nil { phase = .routed } else { recomputeIdlePhase() }
    }

    /// Reset everything.
    func clearAll() {
        autoRouteTask?.cancel()
        start = nil
        end = nil
        drawnTrace = []
        manualSegments = []
        autoRoute = nil
        snapped = nil
        isManuallyEdited = false
        isEditMode = false
        vias = []
        searchResults = []
        errorMessage = nil
        isDrawMode = false
        phase = .idle
    }

    /// Called by the map coordinator when the finger lifts.
    func commitTrace(_ coordinates: [CLLocationCoordinate2D]) {
        drawnTrace = coordinates
    }

    /// Reshape the route by dropping (or moving) a pass-through via point, then
    /// re-routing start → vias → end cleanly along real roads. The dragged point
    /// becomes a via; `movingViaIndex` (when the user grabbed an existing via)
    /// relocates that one instead of inserting a new one.
    ///
    /// `preview` is the rubber-banded line shown during the drag — we display it
    /// immediately so the route doesn't snap back to the old shape while the
    /// re-route is in flight, then replace it with the clean result. On failure
    /// we revert to the route as it was before this drag.
    func reshape(
        to dragged: CLLocationCoordinate2D,
        preview: [CLLocationCoordinate2D],
        movingViaIndex: Int?
    ) async {
        guard let startC = start?.coordinate, let endC = end?.coordinate else { return }

        let previousVias = vias
        let previousSnapped = snapped
        let previousAuto = autoRoute

        if let i = movingViaIndex, vias.indices.contains(i) {
            // Move: respect the via's kind. A precise anchor stays exactly where
            // dropped; a snap waypoint re-snaps to the nearest path (≤100m).
            let moving = vias[i]
            let at = moving.precise
                ? dragged
                : (await BikeFriendliness.shared.nearestNetworkPoint(dragged) ?? dragged)
            vias[i] = Via(id: moving.id, coordinate: at, precise: moving.precise)
        } else {
            // Insert a new snapped waypoint, ordered by arc-length along the route
            // (stable — a re-snap can't reorder it). Don't collapse onto a
            // neighbor: if the snap lands within 8m of an existing via, keep raw.
            let snappedPt = await BikeFriendliness.shared.nearestNetworkPoint(dragged) ?? dragged
            let at = vias.contains(where: { GeoMath.distance($0.coordinate, snappedPt) < 8 }) ? dragged : snappedPt
            // Order against the routable auto geometry (not the spliced display).
            let routeCoords = autoRoute?.coordinates ?? preview
            let key = GeoMath.arcLength(of: at, in: routeCoords)
            let insertAt = vias.filter { GeoMath.arcLength(of: $0.coordinate, in: routeCoords) < key }.count
            vias.insert(Via(coordinate: at, precise: false), at: min(insertAt, vias.count))
        }

        // Show the rubber-banded preview immediately (no snap-back flicker).
        snapped = SnappedRoute(coordinates: preview, distanceMeters: GeoMath.length(preview))
        isManuallyEdited = true
        phase = .routed

        do {
            let routed = try await router.route(
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue
            )
            guard routed.coordinates.count >= 2 else { throw APIError.transport("empty route") }
            autoRoute = routed
            await recomputeDisplay() // re-splice any manual segments onto the fresh route
            isManuallyEdited = false // it's a clean road route now
        } catch {
            // Re-route failed (e.g. via unreachable) — undo this drag.
            vias = previousVias
            autoRoute = previousAuto
            snapped = previousSnapped
            isManuallyEdited = previousVias.isEmpty ? false : isManuallyEdited
        }
    }

    /// Remove a waypoint (tapped pin) and re-route start → remaining vias → end.
    /// The old route stays on screen until the new one lands (no snap-back); on
    /// failure we restore the via and the previous route.
    func deleteVia(at index: Int) async {
        guard vias.indices.contains(index),
              let startC = start?.coordinate, let endC = end?.coordinate else { return }

        let previousVias = vias
        let previousSnapped = snapped
        let previousAuto = autoRoute
        vias.remove(at: index)

        do {
            let routed = try await router.route(
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue
            )
            guard routed.coordinates.count >= 2 else { throw APIError.transport("empty route") }
            autoRoute = routed
            await recomputeDisplay()
            isManuallyEdited = !vias.isEmpty
            phase = .routed
        } catch {
            vias = previousVias
            autoRoute = previousAuto
            snapped = previousSnapped
        }
    }

    /// Long-press on the line: drop a PRECISE anchor exactly there (no snap) so
    /// the route is forced through that point (e.g. a median crossing), then
    /// re-route. Ordered by arc-length; reverts on failure.
    func insertPreciseVia(_ at: CLLocationCoordinate2D) async {
        guard vias.count < Self.maxVias,
              let startC = start?.coordinate, let endC = end?.coordinate else { return }

        let previousVias = vias
        let previousSnapped = snapped
        let previousAuto = autoRoute
        let routeCoords = autoRoute?.coordinates ?? snapped?.coordinates ?? []
        let key = GeoMath.arcLength(of: at, in: routeCoords)
        let insertAt = vias.filter { GeoMath.arcLength(of: $0.coordinate, in: routeCoords) < key }.count
        vias.insert(Via(coordinate: at, precise: true), at: min(insertAt, vias.count))
        isManuallyEdited = true
        phase = .routed

        do {
            let routed = try await router.route(
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue
            )
            guard routed.coordinates.count >= 2 else { throw APIError.transport("empty route") }
            autoRoute = routed
            await recomputeDisplay()
            isManuallyEdited = false
        } catch {
            vias = previousVias
            autoRoute = previousAuto
            snapped = previousSnapped
        }
    }

    /// Raw-nudge a point on a manual segment (drag). No re-route, no snap — keeps
    /// the drawn stretch verbatim, then re-splices.
    func nudgeManualPoint(segmentID: UUID, vertexIndex: Int, to coord: CLLocationCoordinate2D) async {
        guard let si = manualSegments.firstIndex(where: { $0.id == segmentID }),
              manualSegments[si].coords.indices.contains(vertexIndex) else { return }
        manualSegments[si].coords[vertexIndex] = coord
        await recomputeDisplay()
    }

    /// Long-press on a pin: flip it between snap and precise. No re-route — the
    /// coordinate is unchanged; only the kind (and pin color) changes.
    func toggleViaPrecise(at index: Int) {
        guard vias.indices.contains(index) else { return }
        vias[index].precise.toggle()
    }

    /// Finish a manual draw: the stroke becomes a ManualSegment kept VERBATIM and
    /// spliced into the auto route (no /match, no server). Editing/endpoint
    /// changes re-splice it. Too short a stroke is dropped.
    func finishDrawing() async {
        isDrawMode = false
        let stroke = drawnTrace
        drawnTrace = []
        guard stroke.count >= 2 else {
            phase = autoRoute != nil ? .routed : .drawing
            return
        }
        manualSegments.append(ManualSegment(coords: stroke))
        await recomputeDisplay()
        phase = .routed
    }

    // MARK: - Search

    #if DEBUG
    /// Verification hook: auto-route between sample pins, then splice in a manual
    /// drawn stretch (verbatim) — exercising the manual-segment path without a
    /// finger drag. Triggered by the BRN_DEMO launch env var.
    func runDemoSnap() async {
        let startC = CLLocationCoordinate2D(latitude: 45.5415, longitude: -122.6485)
        let endC = CLLocationCoordinate2D(latitude: 45.5505, longitude: -122.6493)
        setPin(startC, kind: .start, label: "Demo start")
        setPin(endC, kind: .end, label: "Demo end")
        await performAutoRoute(from: startC, to: endC)
        // A drawn stretch that bulges west — kept verbatim, spliced into the route.
        manualSegments.append(ManualSegment(coords: [
            CLLocationCoordinate2D(latitude: 45.5450, longitude: -122.6500),
            CLLocationCoordinate2D(latitude: 45.5465, longitude: -122.6515),
            CLLocationCoordinate2D(latitude: 45.5480, longitude: -122.6500),
        ]))
        await recomputeDisplay()
        phase = .routed
    }

    /// Verification hook: run the demo, then raw-nudge the manual segment's
    /// middle point. Triggered by BRN_DEMO=edit.
    func runDemoEdit() async {
        await runDemoSnap()
        guard let seg = manualSegments.first, seg.coords.count >= 3 else { return }
        var p = seg.coords[1]
        p.longitude -= 0.001
        await nudgeManualPoint(segmentID: seg.id, vertexIndex: 1, to: p)
    }
    #endif

    func runSearch(_ query: String) async {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            searchResults = []
            return
        }
        searchResults = (try? await search.geocode(trimmed)) ?? []
    }
}
