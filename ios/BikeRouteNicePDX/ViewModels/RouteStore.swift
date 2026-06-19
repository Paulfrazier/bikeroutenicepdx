import SwiftUI
import CoreLocation

/// Single source of truth for the draw-a-route flow. Injected at the app root
/// and read by every view via `@Environment(RouteStore.self)`.
@MainActor
@Observable
final class RouteStore {
    // Pins
    var start: Waypoint?
    var end: Waypoint?

    // Draw mode
    var isDrawMode = false
    var drawnTrace: [CLLocationCoordinate2D] = []

    /// Ordered drag-to-reshape pass-through waypoints. Each hand-drag drops (or
    /// moves) one of these; the route is re-routed start → vias → end cleanly.
    var vias: [CLLocationCoordinate2D] = []

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

    // Search
    var searchResults: [SearchResult] = []

    // Map controls — incremented to ask the map to recenter on the user's
    // current location (observed by the coordinator in updateUIView).
    private(set) var recenterTick = 0
    func recenterOnUser() { recenterTick += 1 }

    private let match = MatchService()
    private let router = RouteService()
    private let search = SearchService()

    var bothPinsSet: Bool { start != nil && end != nil }

    // MARK: - Pins

    func setPin(_ coordinate: CLLocationCoordinate2D, kind: WaypointKind, label: String) {
        let waypoint = Waypoint(coordinate: coordinate, label: label, kind: kind)
        switch kind {
        case .start: start = waypoint
        case .end: end = waypoint
        }
        // Changing a pin invalidates any existing route.
        snapped = nil
        isManuallyEdited = false
        vias = []
        searchResults = []
        recomputeIdlePhase()
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

    // MARK: - Draw mode

    func enterDrawMode() {
        guard bothPinsSet else { return }
        isDrawMode = true
        drawnTrace = []
        snapped = nil
        isManuallyEdited = false
        vias = []
        errorMessage = nil
        phase = .drawing
    }

    /// Clear the drawn trace + route but keep the pins; re-enter draw mode.
    func clearDraw() {
        drawnTrace = []
        snapped = nil
        isManuallyEdited = false
        vias = []
        errorMessage = nil
        if bothPinsSet {
            isDrawMode = true
            phase = .drawing
        } else {
            isDrawMode = false
            recomputeIdlePhase()
        }
    }

    /// Reset everything.
    func clearAll() {
        start = nil
        end = nil
        drawnTrace = []
        snapped = nil
        isManuallyEdited = false
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

        // Update the via list.
        if let i = movingViaIndex, vias.indices.contains(i) {
            vias[i] = dragged
        } else {
            // Insert in along-route order: count existing vias that come before
            // the dragged point along the current route geometry.
            let routeCoords = previousSnapped?.coordinates ?? preview
            let draggedKey = GeoMath.nearestIndex(of: dragged, in: routeCoords)
            let insertAt = vias.filter {
                GeoMath.nearestIndex(of: $0, in: routeCoords) <= draggedKey
            }.count
            vias.insert(dragged, at: min(insertAt, vias.count))
        }

        // Show the rubber-banded preview immediately (no snap-back flicker).
        snapped = SnappedRoute(coordinates: preview, distanceMeters: GeoMath.length(preview))
        isManuallyEdited = true
        phase = .routed

        do {
            let routed = try await router.route(from: startC, to: endC, vias: vias)
            guard routed.coordinates.count >= 2 else { throw APIError.transport("empty route") }
            snapped = routed
            isManuallyEdited = false // it's a clean road route now
        } catch {
            // Re-route failed (e.g. via unreachable) — undo this drag.
            vias = previousVias
            snapped = previousSnapped
            isManuallyEdited = previousVias.isEmpty ? false : isManuallyEdited
        }
    }

    func finishDrawing() async {
        guard drawnTrace.count >= 2 else {
            // Not enough of a stroke to snap — stay in draw mode.
            phase = .drawing
            return
        }
        isDrawMode = false
        phase = .snapping
        errorMessage = nil
        do {
            snapped = try await match.snap(
                trace: drawnTrace,
                start: start?.coordinate,
                end: end?.coordinate
            )
            phase = .routed
        } catch {
            let message = (error as? APIError)?.errorDescription ?? error.localizedDescription
            errorMessage = message
            phase = .failed(message)
        }
    }

    // MARK: - Search

    #if DEBUG
    /// Verification hook: seed sample pins + a rough trace and snap it, without
    /// needing a finger drag. Triggered by the BRN_DEMO launch env var so the
    /// full iOS→server→Valhalla→display path can be exercised in the simulator.
    func runDemoSnap() async {
        setPin(CLLocationCoordinate2D(latitude: 45.5415, longitude: -122.6485), kind: .start, label: "Demo start")
        setPin(CLLocationCoordinate2D(latitude: 45.5505, longitude: -122.6493), kind: .end, label: "Demo end")
        isDrawMode = false
        drawnTrace = [
            CLLocationCoordinate2D(latitude: 45.5419, longitude: -122.6486),
            CLLocationCoordinate2D(latitude: 45.5440, longitude: -122.6486),
            CLLocationCoordinate2D(latitude: 45.5460, longitude: -122.6488),
            CLLocationCoordinate2D(latitude: 45.5480, longitude: -122.6490),
            CLLocationCoordinate2D(latitude: 45.5500, longitude: -122.6492),
        ]
        await finishDrawing()
    }

    /// Verification hook: run the demo snap, then exercise the manual-edit
    /// commit path by nudging the middle vertex. Triggered by BRN_DEMO=edit.
    func runDemoEdit() async {
        await runDemoSnap()
        guard let coords = snapped?.coordinates, coords.count >= 3 else { return }
        let mid = coords.count / 2
        var dragged = coords[mid]
        dragged.longitude -= 0.0015 // shove the middle of the line west → drop a via
        var preview = coords
        preview[mid] = dragged
        await reshape(to: dragged, preview: preview, movingViaIndex: nil)
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
