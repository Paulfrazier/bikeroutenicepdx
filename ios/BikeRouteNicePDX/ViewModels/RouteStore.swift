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
    /// Set when this via belongs to a "route through this section" corridor — a
    /// chain of pass-through points sampled along a street the user picked. All
    /// vias sharing a `corridorId` are styled together (teal) and deleted as one
    /// unit. Corridor vias are always `precise` (anchored on the chosen road,
    /// never re-snapped to a parallel greenway).
    var corridorId: UUID?

    init(
        id: UUID = UUID(),
        coordinate: CLLocationCoordinate2D,
        precise: Bool = false,
        corridorId: UUID? = nil
    ) {
        self.id = id
        self.coordinate = coordinate
        self.precise = precise
        self.corridorId = corridorId
    }
}

/// A finished Draw-mode stroke. In the from-scratch Draw canvas the strokes ARE
/// the route: each stroke is snapped to roads via `/match`, then the strokes and
/// the gaps to the start/end pins are joined by STRAIGHT bridges (see
/// `GeoMath.assembleDrawnRoute`). When any strokes exist they override the
/// BRouter auto-route for display / distance / coverage / nav.
struct ManualSegment: Identifiable {
    let id: UUID
    var coords: [CLLocationCoordinate2D]

    init(id: UUID = UUID(), coords: [CLLocationCoordinate2D]) {
        self.id = id
        self.coords = coords
    }
}

/// Greenway-vs-speed preference for routing. Sent to the server as `preference`;
/// "ultra" prefers greenways/bike-infra hardest (custom BRouter safety-ultra).
enum RoutePreference: String, CaseIterable, Identifiable {
    case ultra, comfort, balanced, fast
    var id: String { rawValue }
    /// Short label for the segmented control.
    var label: String {
        switch self {
        case .ultra: return "Ultra"
        case .comfort: return "Comfort"
        case .balanced: return "Balanced"
        case .fast: return "Fast"
        }
    }
}

/// Routing engine selection. Sent to the server as `engine`; "prod" uses the
/// production BRouter instance, "selfbuild" uses the experimental self-built graph.
enum RoutingEngine: String, CaseIterable, Identifiable {
    case prod, selfbuild
    var id: String { rawValue }
    /// Short label for the segmented control.
    var label: String {
        switch self {
        case .prod: return "Prod"
        case .selfbuild: return "Self-build"
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

    /// Routing engine ("prod" | "selfbuild"). Persisted across launches.
    /// Changing it while a route is shown recomputes it.
    var routingEngine: RoutingEngine = {
        let raw = UserDefaults.standard.string(forKey: "routingEngine") ?? RoutingEngine.prod.rawValue
        return RoutingEngine(rawValue: raw) ?? .prod
    }() {
        didSet {
            guard oldValue != routingEngine else { return }
            UserDefaults.standard.set(routingEngine.rawValue, forKey: "routingEngine")
            // Recompute the current route under the new engine.
            if bothPinsSet, !isDrawMode { scheduleAutoRoute() }
        }
    }

    // Draw mode
    var isDrawMode = false
    /// When true the map pans/zooms on drag in Draw mode instead of drawing — the
    /// "✋ Move map / ✏️ Draw" toggle. Reset on entering Draw and on exiting reshape
    /// modes. Mirrors the web `drawPaused`.
    var isDrawPaused = false
    /// True while the rider is building a CONNECTOR (a saved global map-fix) by
    /// TAPPING nodes onto the map. Unlike manual draw (`isDrawMode`, freehand pan)
    /// the map stays interactive and each tap appends a node to `connectorPoints`;
    /// the finished link is saved to `Connectors`, not spliced as a one-off.
    var isConnectorDrawMode = false
    /// Tapped nodes of the connector currently being built. The first and last are
    /// the link ends whose nearest roads we resolve + confirm before saving.
    var connectorPoints: [CLLocationCoordinate2D] = []
    /// Nearest named road to the connector's first / last node, resolved live as
    /// the rider taps so the build banner + save confirmation can show which
    /// streets the fix links. nil → no road resolved near that end yet.
    var connectorLinkStart: String?
    var connectorLinkEnd: String?
    var drawnTrace: [CLLocationCoordinate2D] = []

    /// Ordered drag-to-reshape waypoints (stable id + precise flag). Each
    /// hand-drag drops/moves one; the route is re-routed start → vias → end.
    /// PERSISTS across endpoint tweaks — only an explicit reset clears them.
    var vias: [Via] = []

    /// Cap on drag-to-reshape waypoints. Generous — complex routes need many.
    static let maxVias = 40

    /// Finished Draw-mode strokes. The strokes ARE the route (assembled with
    /// straight bridges to the pins — see `GeoMath.assembleDrawnRoute`), overriding
    /// the auto route whenever any exist. Persist across endpoint tweaks; cleared
    /// on an explicit reset OR when entering Build/Draw (the from-scratch wipe).
    var manualSegments: [ManualSegment] = []

    /// Build & Draw are "from scratch" canvases: entering either WIPES every
    /// customization except the start/end pins. We snapshot the wiped state here so
    /// the mode's Undo can restore it once (the "didn't mean to clear" escape
    /// hatch). Mirrors the web `preResetSnapshot`.
    private var preResetSnapshot: (vias: [Via], strokes: [ManualSegment])?

    /// True when entering Build/Draw wiped a route that the mode's Undo can still
    /// restore (drives enabling Undo when the mode's own list is empty).
    var canRestoreSnapshot: Bool { preResetSnapshot != nil }

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

    /// Guided-draw ("Build") mode: tap the map to APPEND pass-through waypoints
    /// one at a time (the router auto-snaps the path between them), tap a pin to
    /// remove it. Unlike drag mode (arc-length insertion) Build appends in tap
    /// order, so the route is built piecemeal start → wp₁ → … → end. The route
    /// line itself stays locked (no drag). Mutually exclusive with the other
    /// reshape modes. Mirrors the web `buildMode`.
    var isBuildMode = false

    // ── "Route through a section" (corridor) ───────────────────────────────
    // Tap point A then point B on a street; the server resolves the street
    // between them into an ordered chain of pass-through points (the preview).
    // On confirm those points are injected as a grouped block of `precise` vias,
    // so the route recomputes to flow through that street.
    var isCorridorMode = false
    var corridorA: CLLocationCoordinate2D?
    var corridorB: CLLocationCoordinate2D?
    var corridorPreview: CorridorPreview?
    var corridorLoading = false
    var corridorError: String?

    // Search
    var searchResults: [SearchResult] = []

    /// Minimum characters before we hit the geocoder (saves the scarce 1-rps budget).
    static let minSearchLength = 3

    /// Recent picks, persisted to UserDefaults. Most-recent-first, deduped by
    /// coordinate, capped — shown when the search field is empty.
    private(set) var recentSearches: [SearchResult] = {
        guard let data = UserDefaults.standard.data(forKey: "recentSearches"),
              let list = try? JSONDecoder().decode([SearchResult].self, from: data)
        else { return [] }
        return list
    }()
    private static let maxRecents = 5

    /// In-memory geocoder cache (normalized query → results). Pairs with the
    /// server cache so repeated / backspace-and-retype queries are instant.
    private var searchCache: [String: [SearchResult]] = [:]

    // Map controls — incremented to ask the map to recenter on the user's
    // current location (observed by the coordinator in updateUIView).
    private(set) var recenterTick = 0
    func recenterOnUser() { recenterTick += 1 }

    // Bumped to ask the map to set the route START to the user's current
    // location (observed by the coordinator, which has the live GPS fix).
    private(set) var useLocationTick = 0
    func useMyLocationAsStart() { useLocationTick += 1 }

    private let router = RouteService()
    private let search = SearchService()
    private let corridorService = CorridorService()

    /// In-flight corridor resolve, cancellable so changing the pick mid-request
    /// can't land a stale preview.
    private var corridorTask: Task<Void, Never>?

    /// Debounce/cancel token for the auto-route. Cancelling it both aborts the
    /// pending ~350ms delay and flags the in-flight request as stale so a late
    /// network result can't clobber a newer route.
    private var autoRouteTask: Task<Void, Never>?

    var bothPinsSet: Bool { start != nil && end != nil }

    // ── Tap-to-rate a street ───────────────────────────────────────────────
    /// The normalized street name awaiting a personal rating (a long-press on the
    /// map resolved a street under the finger). Non-nil drives the rating
    /// confirmation dialog in RootView; cleared when the user picks or cancels.
    var pendingRatingStreet: String?
    /// Bumped when a rate long-press landed on no nearby street, so RootView can
    /// flash a brief "no street here" hint.
    private(set) var noStreetTick = 0

    // ── Tap a built-but-unpublished "supplement" lane ──────────────────────────
    /// The supplement lane the user tapped (a PBOT lane built 2024-2026, not yet
    /// on the published map). Non-nil drives the "learn more about this network"
    /// sheet in RootView; cleared when the sheet is dismissed.
    var selectedSupplement: SupplementInfo?

    init() {
        // A personal street-rating change (from the manage sheet or tap-to-rate)
        // must recolor the CURRENT route + update its comfort coverage live. The
        // classifier already reads the new overrides on its next pass, so we just
        // re-classify the route on screen. [weak self] → no retain cycle.
        NotificationCenter.default.addObserver(
            forName: .streetRatingsChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.reclassifyForRatingChange() }
        }
        // A personal-connector change (drawn/renamed/deleted) must rebuild the
        // classifier's connector index, then re-splice + recolor the route on
        // screen so a freshly drawn fix takes effect everywhere at once.
        NotificationCenter.default.addObserver(
            forName: .connectorsChanged, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                await BikeFriendliness.shared.reloadConnectors()
                await self?.recomputeDisplay()
            }
        }
    }

    /// Resolve the street under a map long-press and, if one is near, arm the
    /// rating dialog; otherwise flash the "no street here" hint. Called by the
    /// map coordinator (which has the tapped coordinate).
    func requestRating(at coordinate: CLLocationCoordinate2D) {
        Task {
            let name = await BikeFriendliness.shared.nearestStreetName(coordinate)
            if let name {
                pendingRatingStreet = name
            } else {
                noStreetTick += 1
            }
        }
    }

    /// Re-classify the route currently on screen (no server call) so a rating
    /// change updates its per-segment colors + coverage immediately.
    func reclassifyForRatingChange() async {
        guard let current = snapped else { return }
        snapped = await classified(current)
    }

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
        isBuildMode = false
        isDrawMode = false
        // Leaving Build/Draw on an endpoint change drops the undo-the-wipe escape
        // hatch (the snapshot is anchored to the old route).
        preResetSnapshot = nil
        // An in-progress corridor pick is anchored to the old route — abandon it.
        isCorridorMode = false
        clearCorridorPick()
        searchResults = []
        recomputeIdlePhase()
        scheduleAutoRoute()
    }

    /// Tap on the map (when not drawing): fill start, then end. In corridor mode
    /// a tap instead picks the section endpoints (A then B).
    func handleMapTap(_ coordinate: CLLocationCoordinate2D) {
        if isCorridorMode {
            handleCorridorTap(coordinate)
            return
        }
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
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue, engine: routingEngine.rawValue
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

    // MARK: - Navigation reroute

    /// Live-navigation reroute: recompute current location → destination via the
    /// same BRouter path (keeps greenway quality), classify it, and publish to
    /// `snapped` so the map line updates under the rider. Deliberately does NOT
    /// touch vias / manual segments / `autoRoute` — `NavigationSession` restores
    /// the original planned route when navigation ends. Returns the fresh route,
    /// or nil on failure (the caller keeps guiding on the old line).
    func navReroute(from: CLLocationCoordinate2D, to: CLLocationCoordinate2D) async -> SnappedRoute? {
        do {
            let routed = try await router.route(from: from, to: to, vias: [], preference: routePreference.rawValue, engine: routingEngine.rawValue)
            guard routed.coordinates.count >= 2 else { return nil }
            let enriched = await classified(routed)
            snapped = enriched
            return enriched
        } catch {
            return nil
        }
    }

    /// Attach per-segment facility classes + coverage to a freshly computed
    /// route. Shared by the auto-route, drag-reshape, and finger-draw paths.
    private func classified(_ route: SnappedRoute) async -> SnappedRoute {
        let result = await BikeFriendliness.shared.classify(route.coordinates)
        var enriched = route
        enriched.routeClasses = result.classes
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

    /// Connectors (community + personal map-fixes) whose BOTH endpoints lie within
    /// `maxMeters` of the route — the ones to splice into it. Returned as
    /// `ManualSegment`s so they fold into `applyManualSegments()` exactly like a
    /// hand-drawn stretch. Mirrors web `connectorSegmentsForRoute`.
    static func connectorSegmentsForRoute(
        _ routeCoords: [CLLocationCoordinate2D],
        maxMeters: Double = 30
    ) -> [ManualSegment] {
        guard routeCoords.count >= 2 else { return [] }
        var candidates: [[CLLocationCoordinate2D]] = CommunityConnectors.lines()
        candidates.append(contentsOf: Connectors.list().map { $0.coords })
        var out: [ManualSegment] = []
        for coords in candidates {
            guard coords.count >= 2, let head = coords.first, let tail = coords.last else { continue }
            if GeoMath.distanceToPolyline(head, routeCoords) <= maxMeters
                && GeoMath.distanceToPolyline(tail, routeCoords) <= maxMeters {
                out.append(ManualSegment(coords: coords))
            }
        }
        return out
    }

    /// Rebuild the display route, classify it, and publish to `snapped`. No server
    /// call. Two cases (web parity with `activeCoords`):
    ///   1. Draw-mode strokes present → the strokes ARE the route: snap-joined by
    ///      straight bridges to the pins (`assembleDrawnRoute`), overriding auto.
    ///   2. Otherwise → the auto route with qualifying connectors spliced in.
    private func recomputeDisplay() async {
        // From-scratch canvas: until the rider draws a stroke (Draw) or drops a
        // waypoint (Build), show no route line — only the start/end pins + network
        // overlay. Mirrors web `blankCanvas`; the web `!nav.navigating` clause is
        // implicit here because neither reshape mode is ever active while navigating.
        if (isDrawMode && manualSegments.isEmpty) || (isBuildMode && vias.isEmpty) {
            snapped = nil
            return
        }
        // Build mode (pre-Finish): preview the waypoints as STRAIGHT lines
        // start → wp₁ → … → end. No routing happens until Finish links them
        // (web parity with the buildMode branch of `activeCoords`).
        if isBuildMode, !vias.isEmpty, let startC = start?.coordinate, let endC = end?.coordinate {
            var coords = [startC]
            coords.append(contentsOf: vias.map(\.coordinate))
            coords.append(endC)
            guard coords.count >= 2 else { snapped = nil; return }
            var base = SnappedRoute(coordinates: coords, distanceMeters: GeoMath.length(coords))
            base.durationSeconds = 0
            base.steps = []
            snapped = await classified(base)
            return
        }
        // A fully hand-drawn route (Draw strokes) overrides everything.
        if !manualSegments.isEmpty, let startC = start?.coordinate, let endC = end?.coordinate {
            let coords = GeoMath.assembleDrawnRoute(
                from: startC, to: endC, strokes: manualSegments.map(\.coords)
            )
            guard coords.count >= 2 else { snapped = nil; return }
            var base = SnappedRoute(coordinates: coords, distanceMeters: GeoMath.length(coords))
            // A hand-drawn route has no engine time estimate or turn-by-turn steps.
            base.durationSeconds = autoRoute?.durationSeconds ?? 0
            base.steps = []
            snapped = await classified(base)
            return
        }
        guard let auto = autoRoute else { snapped = nil; return }
        // Fold in connectors that pass near both ends of the auto route (web parity:
        // applyManualSegments(auto, connectorSegmentsForRoute(auto))).
        let connectors = Self.connectorSegmentsForRoute(auto.coordinates)
        let coords = Self.applyManualSegments(auto.coordinates, connectors)
        var base = SnappedRoute(coordinates: coords, distanceMeters: GeoMath.length(coords))
        // Carry the server's time estimate + turn-by-turn steps from the auto route
        // so the duration label and Directions button survive the rebuild.
        base.durationSeconds = auto.durationSeconds
        base.steps = auto.steps
        snapped = await classified(base)
    }

    /// Re-route start → vias → end WITHOUT flipping into the `.snapping` spinner
    /// (keeps the routed UI + edit panel visible). Used when entering Build/Draw
    /// (after the wipe) and when restoring a snapshot. Re-splices via recomputeDisplay.
    private func rerouteKeepingPhase() async {
        guard let startC = start?.coordinate, let endC = end?.coordinate else {
            await recomputeDisplay()
            return
        }
        do {
            let routed = try await router.route(
                from: startC, to: endC, vias: vias.map(\.coordinate),
                preference: routePreference.rawValue, engine: routingEngine.rawValue
            )
            guard routed.coordinates.count >= 2 else { return }
            autoRoute = routed
            await recomputeDisplay()
        } catch {
            // Keep the previous route on failure.
        }
    }

    // MARK: - Draw mode

    /// Enter Draw mode — a "from scratch" hand-route canvas. Wipes every
    /// customization except the start/end pins (snapshotting it first so Undo can
    /// restore once), then each stroke drawn is snapped to roads and joined by
    /// straight bridges: the strokes ARE the route. Resumable — stays in Draw mode
    /// after each stroke. Mirrors the web `selectEditTool("draw")`.
    func enterDrawMode() {
        autoRouteTask?.cancel()
        guard bothPinsSet else { return }
        let hadCustom = !vias.isEmpty || !manualSegments.isEmpty
        if hadCustom { preResetSnapshot = (vias, manualSegments) }
        vias = []
        manualSegments = []
        isEditMode = false
        isBuildMode = false
        isCorridorMode = false
        clearCorridorPick()
        isDrawMode = true
        isDrawPaused = false
        drawnTrace = []
        errorMessage = nil
        isManuallyEdited = false
        phase = .routed
        // Blank the route line on entry (web `blankCanvas`): reroute when custom
        // work was wiped (keeps autoRoute fresh for the duration fallback), else
        // recompute directly — both land on the empty-canvas guard until the first
        // stroke, so the old auto line disappears immediately.
        if hadCustom { Task { await rerouteKeepingPhase() } }
        else { Task { await recomputeDisplay() } }
    }

    /// Enter CONNECTOR-build mode: TAP nodes onto the map to trace a fix, which is
    /// saved as a global connector (a comfortable `path` map-fix) instead of a
    /// per-route segment. The map stays interactive (pan/zoom) — unlike the
    /// freehand `enterDrawMode` — and needs no existing route: connectors are built
    /// standalone and apply to every future route. Mutually exclusive with the
    /// other reshape modes.
    func enterConnectorMode() {
        autoRouteTask?.cancel()
        isEditMode = false
        isBuildMode = false
        isCorridorMode = false
        isDrawMode = false
        clearCorridorPick()
        isConnectorDrawMode = true
        connectorPoints = []
        connectorLinkStart = nil
        connectorLinkEnd = nil
        errorMessage = nil
    }

    /// Append a tapped node to the connector being built, then refresh the
    /// resolved link-road names so the banner shows what this fix will link.
    func addConnectorPoint(_ coordinate: CLLocationCoordinate2D) {
        connectorPoints.append(coordinate)
        refreshConnectorLinks()
    }

    /// Remove the placed node at `index` (tapping an existing node deletes it).
    func removeConnectorNode(at index: Int) {
        guard connectorPoints.indices.contains(index) else { return }
        connectorPoints.remove(at: index)
        refreshConnectorLinks()
    }

    /// Drop the last placed node (the build banner's Undo).
    func undoConnectorPoint() {
        guard !connectorPoints.isEmpty else { return }
        connectorPoints.removeLast()
        refreshConnectorLinks()
    }

    /// Resolve the nearest named road to the first + last node so the rider can
    /// confirm which streets the fix links. Best-effort (a node off any street →
    /// nil → shown as "an unnamed spot"). A slightly generous radius since a tap
    /// rarely lands exactly on the centerline.
    private func refreshConnectorLinks() {
        let first = connectorPoints.first
        let last = connectorPoints.count >= 2 ? connectorPoints.last : nil
        Task {
            let a = first == nil ? nil
                : await BikeFriendliness.shared.nearestStreetName(first!, maxMeters: 45)
            let b = last == nil ? nil
                : await BikeFriendliness.shared.nearestStreetName(last!, maxMeters: 45)
            connectorLinkStart = a
            connectorLinkEnd = b
        }
    }

    /// A human label for the fix built from its resolved link roads (e.g.
    /// "NE 21st Ave ↔ NE Tillamook St"), or nil when neither end resolved.
    func connectorLinkName() -> String? {
        switch (connectorLinkStart, connectorLinkEnd) {
        case let (a?, b?): return "\(a) ↔ \(b)"
        case let (a?, nil): return a
        case let (nil, b?): return b
        default: return nil
        }
    }

    /// Save the built connector as a personal fix linking its two ends, auto-named
    /// from the resolved roads. The `.connectorsChanged` observer then rebuilds the
    /// classifier index and re-splices/recolors any route on screen. Needs ≥2 nodes.
    @discardableResult
    func saveConnector() -> Bool {
        guard connectorPoints.count >= 2 else { return false }
        Connectors.add(coords: connectorPoints, name: connectorLinkName())
        exitConnectorMode()
        return true
    }

    /// Leave connector-build mode, discarding any in-progress nodes.
    func exitConnectorMode() {
        isConnectorDrawMode = false
        connectorPoints = []
        connectorLinkStart = nil
        connectorLinkEnd = nil
    }

    /// Clear manual segments (and the drawn trace), keep the auto route + pins.
    func clearDraw() {
        autoRouteTask?.cancel()
        isDrawMode = false
        isConnectorDrawMode = false
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
        isBuildMode = false
        preResetSnapshot = nil
        vias = []
        searchResults = []
        errorMessage = nil
        isDrawMode = false
        isConnectorDrawMode = false
        connectorPoints = []
        connectorLinkStart = nil
        connectorLinkEnd = nil
        isCorridorMode = false
        clearCorridorPick()
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
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue, engine: routingEngine.rawValue
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
    /// failure we restore the via and the previous route. If the tapped via
    /// belongs to a corridor ("route through a section"), the whole `corridorId`
    /// group is removed at once so a section deletes as one unit.
    func deleteVia(at index: Int) async {
        guard vias.indices.contains(index),
              let startC = start?.coordinate, let endC = end?.coordinate else { return }

        let previousVias = vias
        let previousSnapped = snapped
        let previousAuto = autoRoute
        if let corridorId = vias[index].corridorId {
            vias.removeAll { $0.corridorId == corridorId }
        } else {
            vias.remove(at: index)
        }

        // In Build mode the chain is a straight-line preview (not yet linked), so a
        // delete just re-previews — no routing until Finish.
        if isBuildMode {
            isManuallyEdited = !vias.isEmpty
            phase = .routed
            await recomputeDisplay()
            return
        }

        do {
            let routed = try await router.route(
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue, engine: routingEngine.rawValue
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

    /// Guided-draw ("Build") mode: a bare map tap APPENDS a pass-through waypoint
    /// at the end of the chain (tap order, NOT arc-length), so the route builds
    /// piecemeal start → wp₁ → … → end. The point snaps to the nearest bike-network
    /// edge (unless that collapses onto an existing via, ≤8m) and is capped at
    /// maxVias. While building, waypoints are joined by STRAIGHT lines and are NOT
    /// routed — Finish (`finishBuild`) links them. Mirrors the web `handleAddWaypoint`.
    func addWaypoint(_ rawAt: CLLocationCoordinate2D) async {
        guard vias.count < Self.maxVias,
              start?.coordinate != nil, end?.coordinate != nil else { return }

        // Committing to the new canvas — the wipe is no longer undoable.
        preResetSnapshot = nil
        let snappedPt = await BikeFriendliness.shared.nearestNetworkPoint(rawAt) ?? rawAt
        let at = vias.contains(where: { GeoMath.distance($0.coordinate, snappedPt) < 8 }) ? rawAt : snappedPt
        vias.append(Via(coordinate: at, precise: false))
        isManuallyEdited = true
        phase = .routed
        // Straight-line preview only; the route is linked on Finish.
        await recomputeDisplay()
    }

    /// Build mode Undo: drop the most-recently-added waypoint and re-route; once the
    /// canvas is empty, restore the snapshot taken when Build was entered (undo the
    /// wipe). Mirrors the web `handleUndoWaypoint`.
    func undoWaypoint() async {
        if !vias.isEmpty {
            await deleteVia(at: vias.count - 1)
            return
        }
        await restoreSnapshot()
    }

    /// Build mode: remove every waypoint at once. The chain is a straight-line
    /// preview (not yet linked), so this just blanks the canvas — no routing.
    func clearWaypoints() async {
        guard !vias.isEmpty else { return }
        vias = []
        isManuallyEdited = false
        phase = .routed
        await recomputeDisplay()
    }

    /// Build mode Finish: link the waypoints into a route. Leaving Build mode lets
    /// the waypoints feed the router (start → vias → end via BRouter — the "final
    /// linking"), replacing the straight-line preview. Mirrors web `handleFinishBuild`.
    func finishBuild() async {
        isBuildMode = false
        preResetSnapshot = nil
        guard !vias.isEmpty else { await recomputeDisplay(); return }
        isManuallyEdited = true
        await rerouteKeepingPhase()
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
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue, engine: routingEngine.rawValue
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

    /// Finished a freehand Draw stroke: keep it VERBATIM (no snapping — the line
    /// stays exactly where it was traced) and append it to the drawn route. Stays
    /// in Draw mode so drawing is resumable (the next stroke picks up from the pen).
    /// Mirrors the web `handleDrawStroke`.
    func addDrawnStroke(_ coords: [CLLocationCoordinate2D]) async {
        guard coords.count >= 2 else { return }
        // Committing to the new canvas — the wipe is no longer undoable.
        preResetSnapshot = nil
        manualSegments.append(ManualSegment(coords: coords))
        isManuallyEdited = false
        await recomputeDisplay()
        phase = .routed
    }

    /// Draw mode Undo: drop the last stroke; once empty, restore the snapshot taken
    /// when Draw was entered (undo the wipe). Mirrors the web `handleUndoStroke`.
    func undoDrawnStroke() async {
        if !manualSegments.isEmpty {
            manualSegments.removeLast()
            await recomputeDisplay()
            return
        }
        await restoreSnapshot()
    }

    /// Draw mode: remove every stroke at once (the wipe stays restorable via Undo).
    func clearDrawnStrokes() async {
        guard !manualSegments.isEmpty else { return }
        manualSegments = []
        await recomputeDisplay()
    }

    /// Undo the from-scratch wipe: restore the snapshot captured when Build/Draw was
    /// entered, then drop into Drag so the restored route shows normally for
    /// fine-tuning. Mirrors the web `restoreSnapshot`.
    func restoreSnapshot() async {
        guard let snap = preResetSnapshot else { return }
        preResetSnapshot = nil
        vias = snap.vias
        manualSegments = snap.strokes
        isEditMode = true
        isDrawMode = false
        isBuildMode = false
        isCorridorMode = false
        clearCorridorPick()
        isManuallyEdited = !vias.isEmpty
        await rerouteKeepingPhase()
    }

    // MARK: - Route through a section (corridor)

    /// Toggle corridor ("route through a section") mode. Mutually exclusive with
    /// edit/draw modes; entering clears any half-finished pick. Mirrors the web
    /// `handleToggleCorridorMode`.
    func toggleCorridorMode() {
        let next = !isCorridorMode
        if next {
            isEditMode = false
            isBuildMode = false
            isDrawMode = false
        }
        clearCorridorPick()
        isCorridorMode = next
    }

    /// Enter drag-to-reshape mode, turning off draw/corridor (the three reshape
    /// modes are mutually exclusive — exactly one active at a time).
    func enterEditMode() {
        isDrawMode = false
        isBuildMode = false
        isCorridorMode = false
        clearCorridorPick()
        isEditMode = true
    }

    /// Enter guided-draw ("Build") mode — a "from scratch" canvas. Wipes every
    /// customization except the start/end pins (snapshotting it first so Undo can
    /// restore once), then tap the map to append pass-through waypoints one at a
    /// time. Mirrors the web `selectEditTool("build")`.
    func enterBuildMode() {
        autoRouteTask?.cancel()
        guard bothPinsSet else { return }
        let hadCustom = !vias.isEmpty || !manualSegments.isEmpty
        if hadCustom { preResetSnapshot = (vias, manualSegments) }
        vias = []
        manualSegments = []
        isDrawMode = false
        isEditMode = false
        isCorridorMode = false
        clearCorridorPick()
        isBuildMode = true
        isManuallyEdited = false
        // Blank the route line on entry (web `blankCanvas`) until the first
        // waypoint — see enterDrawMode for the reroute-vs-recompute split.
        if hadCustom { Task { await rerouteKeepingPhase() } }
        else { Task { await recomputeDisplay() } }
    }

    /// Leave all reshape modes (drag/draw/corridor/build) — backs the grouped
    /// "Done editing" toggle. The drawn route / waypoints persist (only an explicit
    /// reset or re-entering Build/Draw clears them); the undo-the-wipe snapshot drops.
    func exitReshapeModes() {
        isEditMode = false
        isBuildMode = false
        isDrawMode = false
        isDrawPaused = false
        isCorridorMode = false
        preResetSnapshot = nil
        clearCorridorPick()
    }

    /// Clear an in-progress corridor pick (both endpoints, the preview, and any
    /// loading/error state) and cancel any in-flight resolve. Stays in corridor
    /// mode — used by both Cancel and an endpoint change.
    func clearCorridorPick() {
        corridorTask?.cancel()
        corridorA = nil
        corridorB = nil
        corridorPreview = nil
        corridorLoading = false
        corridorError = nil
    }

    /// Cancel the previewed/in-progress pick but stay in corridor mode (web's
    /// "Cancel" button), so the next tap starts a fresh A.
    func cancelCorridorPick() {
        clearCorridorPick()
    }

    /// A corridor-mode map tap: the first tap places point A; the second resolves
    /// the street between A and B into the preview. Changing an endpoint abandons
    /// an in-progress pick (its preview is anchored to the old pair).
    private func handleCorridorTap(_ coordinate: CLLocationCoordinate2D) {
        if corridorA == nil {
            corridorA = coordinate
            corridorB = nil
            corridorPreview = nil
            corridorError = nil
        } else if let a = corridorA {
            resolveCorridorPick(from: a, to: coordinate)
        }
    }

    /// Second corridor tap: resolve the literal street between A and B into an
    /// ordered chain of pass-through points (the preview). Cancellable so a fresh
    /// pick can't land a stale result. On failure the pick resets to "tap A".
    private func resolveCorridorPick(from a: CLLocationCoordinate2D, to b: CLLocationCoordinate2D) {
        corridorTask?.cancel()
        corridorB = b
        corridorLoading = true
        corridorError = nil
        corridorPreview = nil
        corridorTask = Task { [weak self] in
            guard let self else { return }
            do {
                let preview = try await self.corridorService.corridor(a: a, b: b)
                if Task.isCancelled { return }
                self.corridorPreview = preview
                self.corridorLoading = false
            } catch {
                if Task.isCancelled { return }
                self.corridorError = "Couldn't find a street between those points — tap closer together along one road."
                self.corridorLoading = false
                // Drop the failed pick so the next tap starts a fresh A.
                self.corridorA = nil
                self.corridorB = nil
            }
        }
    }

    /// Confirm the previewed corridor: inject its sampled points as a grouped
    /// block of `precise` vias, ordered along the current route's direction of
    /// travel, then re-route through them. The block stays contiguous (one
    /// shared `corridorId`) so it deletes as one unit. Mirrors the web
    /// `handleConfirmCorridor`; reverts the splice on a re-route failure.
    func confirmCorridor() async {
        guard let preview = corridorPreview, preview.points.count >= 2,
              let startC = start?.coordinate, let endC = end?.coordinate else { return }

        // Order against the routable auto geometry (not the spliced display).
        let routeCoords = autoRoute?.coordinates ?? snapped?.coordinates ?? []
        var pts = preview.points
        // Orient so the endpoint nearer the route start comes first.
        if routeCoords.count >= 2 {
            let headArc = GeoMath.arcLength(of: pts[0], in: routeCoords)
            let tailArc = GeoMath.arcLength(of: pts[pts.count - 1], in: routeCoords)
            if headArc > tailArc { pts.reverse() }
        }
        // Downsample to the remaining via slots (keep first + last) so a long
        // corridor can't blow past maxVias.
        let slots = Self.maxVias - vias.count
        guard slots >= 2 else { return }
        if pts.count > slots {
            let stride = Double(pts.count - 1) / Double(slots - 1)
            pts = (0..<slots).map { pts[Int((Double($0) * stride).rounded())] }
        }
        let corridorId = UUID()
        let block = pts.map { Via(coordinate: $0, precise: true, corridorId: corridorId) }
        // Insert the whole block at the arc-length position of its midpoint.
        let midArc = GeoMath.arcLength(of: pts[pts.count / 2], in: routeCoords)
        let insertAt = vias.filter { GeoMath.arcLength(of: $0.coordinate, in: routeCoords) <= midArc }.count

        // The block is committed to vias now — leave corridor mode + clear the pick.
        isCorridorMode = false
        clearCorridorPick()

        let previousVias = vias
        let previousSnapped = snapped
        let previousAuto = autoRoute
        vias.insert(contentsOf: block, at: min(insertAt, vias.count))
        isManuallyEdited = true
        phase = .routed

        do {
            let routed = try await router.route(
                from: startC, to: endC, vias: vias.map(\.coordinate), preference: routePreference.rawValue, engine: routingEngine.rawValue
            )
            guard routed.coordinates.count >= 2 else { throw APIError.transport("empty route") }
            autoRoute = routed
            await recomputeDisplay() // re-splice any manual segments onto the fresh route
            isManuallyEdited = false // it's a clean road route now
        } catch {
            // Re-route failed (e.g. the section is unreachable) — undo the splice.
            vias = previousVias
            autoRoute = previousAuto
            snapped = previousSnapped
            isManuallyEdited = previousVias.isEmpty ? false : isManuallyEdited
        }
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
        guard trimmed.count >= Self.minSearchLength else {
            searchResults = []
            return
        }
        let key = trimmed.lowercased()
        if let cached = searchCache[key] {
            searchResults = cached
            return
        }
        let results = (try? await search.geocode(trimmed)) ?? []
        // A cancelled Task throws → results stays []; don't cache/replace on cancel.
        if Task.isCancelled { return }
        searchCache[key] = results
        searchResults = results
    }

    /// Record a pick in recents (most-recent-first, deduped by coordinate, capped).
    func addRecent(_ result: SearchResult) {
        recentSearches.removeAll { $0.lng == result.lng && $0.lat == result.lat }
        recentSearches.insert(result, at: 0)
        if recentSearches.count > Self.maxRecents {
            recentSearches = Array(recentSearches.prefix(Self.maxRecents))
        }
        if let data = try? JSONEncoder().encode(recentSearches) {
            UserDefaults.standard.set(data, forKey: "recentSearches")
        }
    }
}
