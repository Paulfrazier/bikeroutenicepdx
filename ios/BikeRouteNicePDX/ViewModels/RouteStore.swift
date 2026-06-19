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
        errorMessage = nil
        phase = .drawing
    }

    /// Clear the drawn trace + route but keep the pins; re-enter draw mode.
    func clearDraw() {
        drawnTrace = []
        snapped = nil
        isManuallyEdited = false
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
        searchResults = []
        errorMessage = nil
        isDrawMode = false
        phase = .idle
    }

    /// Called by the map coordinator when the finger lifts.
    func commitTrace(_ coordinates: [CLLocationCoordinate2D]) {
        drawnTrace = coordinates
    }

    /// Commit a hand-dragged line. Shows the raw drag instantly for feedback, then
    /// re-snaps it onto roads via /match so it stops being squiggly. The `follow`
    /// flag lets the snap drift onto whatever road the user dragged toward (incl.
    /// non-bike streets). If the match fails (e.g. dragged far off any road) the
    /// raw line is kept — honoring the user's intent rather than erroring out.
    func commitEdit(_ coords: [CLLocationCoordinate2D]) async {
        // 1. Instant feedback: show the line exactly where the finger left it.
        snapped = SnappedRoute(coordinates: coords, distanceMeters: GeoMath.length(coords))
        isManuallyEdited = true
        phase = .routed

        // 2. Re-snap onto roads, following the drawn path.
        do {
            let resnapped = try await match.snap(
                trace: coords,
                start: start?.coordinate,
                end: end?.coordinate,
                follow: true
            )
            guard resnapped.coordinates.count >= 2 else { return } // keep raw on empty match
            snapped = resnapped
            isManuallyEdited = false // it's snapped to roads now
        } catch {
            // Keep the raw dragged line; don't surface a blocking error.
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
        guard var coords = snapped?.coordinates, coords.count >= 3 else { return }
        let mid = coords.count / 2
        coords[mid].longitude -= 0.0015 // shove the middle of the line west
        await commitEdit(coords)
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
