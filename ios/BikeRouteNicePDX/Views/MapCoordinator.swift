import MapKit
import UIKit

/// MKMapView delegate + gesture handling for the draw-a-route map.
/// MainActor-isolated because all MapKit/UIKit interaction happens on main.
@MainActor
final class MapCoordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
    var store: RouteStore
    weak var mapView: MKMapView?
    var tapGesture: UITapGestureRecognizer?
    var panGesture: UIPanGestureRecognizer?
    var editPanGesture: UIPanGestureRecognizer?
    var editLongPressGesture: UILongPressGestureRecognizer?

    private let locationManager = CLLocationManager()
    private var lastRecenterTick = 0
    private var pendingRecenter = false
    private var lastUseLocationTick = 0
    private var pendingUseLocationStart = false
    private var lastRouteVersion = 0

    private var startAnnotation: MKPointAnnotation?
    private var endAnnotation: MKPointAnnotation?
    /// Emerald handle dots at each drag-to-reshape waypoint (via). Shown only in
    /// edit mode; drag a pin to move it, tap it to delete it.
    private var viaAnnotations: [ViaAnnotation] = []
    /// The displayed route, one overlay per contiguous bike-friendliness tier
    /// run (replaces the old single blue line).
    private var routeOverlays: [MKOverlay] = []
    /// Dashed-violet overlays marking the hand-drawn (manual) stretches.
    private var manualOverlays: [ManualPolyline] = []
    /// Teal highlight (line + white casing) of the picked "route through a
    /// section" street, shown only while in corridor mode.
    private var corridorOverlays: [MKOverlay] = []
    /// The two tapped corridor endpoints (A, B), shown as teal dots while picking.
    private var corridorAnnotations: [CorridorEndpointAnnotation] = []
    /// Single rubber-banded preview line shown while a hand-edit drag is live.
    private var editPreviewOverlay: RoutePolyline?
    /// True while a route is on screen — fades the bike-network overlay back so
    /// the route reads as the foreground (toggled in sync()/removeRouteOverlays).
    private var networkFaded = false

    // Live finger-draw state (kept here, not in the store, so map moves don't
    // thrash SwiftUI's updateUIView while the finger is down).
    private var draftOverlay: DraftPolyline?
    private var draftCoords: [CLLocationCoordinate2D] = []
    private var lastScreenPoint: CGPoint?

    private static let minScreenStep: CGFloat = 8 // points between captured samples

    // Live hand-edit state (also kept here, not in the store, so a drag doesn't
    // thrash updateUIView). While `isEditing` is true sync() leaves the map and
    // its overlay alone so an unrelated store change can't yank the line.
    private var editCoords: [CLLocationCoordinate2D] = []
    private var editingIndex: Int?
    private var editingViaIndex: Int? // set when the drag grabbed an existing via
    // Set when the drag grabbed a point on a manual (drawn) segment → raw nudge
    // of that segment's vertex instead of a via re-route.
    private var editingManualSegID: UUID?
    private var editingManualVertex: Int?
    private var isEditing = false

    private static let vertexGrabPx: CGFloat = 22 // tap radius to grab a vertex
    private static let lineGrabPx: CGFloat = 16   // tap radius to grab a segment

    init(store: RouteStore) {
        self.store = store
    }

    // MARK: - Declarative reconcile (called from updateUIView)

    func sync() {
        guard let map = mapView else { return }

        // An active hand-edit drag owns the map and the overlay — don't let an
        // unrelated store change re-run reconcile, rebuild the line, or flip the
        // scroll lock back on mid-drag.
        if isEditing { return }

        // Recenter on the user when the store's tick advances (locate button).
        if store.recenterTick != lastRecenterTick {
            lastRecenterTick = store.recenterTick
            recenterOnUser(map)
        }

        // Set the start pin to the user's current location ("Use my location").
        if store.useLocationTick != lastUseLocationTick {
            lastUseLocationTick = store.useLocationTick
            useCurrentLocationAsStart(map)
        }

        // Lock map interaction while drawing so our pan gesture owns the touch.
        let drawing = store.isDrawMode
        map.isScrollEnabled = !drawing
        map.isZoomEnabled = !drawing
        map.isRotateEnabled = !drawing
        map.isPitchEnabled = !drawing
        panGesture?.isEnabled = drawing
        tapGesture?.isEnabled = !drawing

        // Hand-edit pan is live only when a finished route is on screen, we're not
        // drawing, AND the user has explicitly entered edit mode. Outside edit mode
        // the route is non-interactive so the map pans freely over it (no accidental
        // grabs). It's also off in corridor mode so taps pick the section instead of
        // being swallowed. shouldBegin further gates it to touches on the line.
        editPanGesture?.isEnabled = (store.snapped != nil && !drawing && store.isEditMode && !store.isCorridorMode)

        syncAnnotation(&startAnnotation, waypoint: store.start, title: "Start", map: map)
        syncAnnotation(&endAnnotation, waypoint: store.end, title: "End", map: map)
        syncViaAnnotations(map)
        syncManualOverlays(map)
        syncCorridorPreview(map)

        if let snapped = store.snapped {
            // Rebuild when the route identity changes (routeVersion), not just its
            // point count — a re-snap can return the same count as the raw line it
            // replaces, which a count check would miss.
            let nothingShown = routeOverlays.isEmpty && editPreviewOverlay == nil
            let needsUpdate = nothingShown || store.routeVersion != lastRouteVersion
            lastRouteVersion = store.routeVersion
            if needsUpdate {
                // Only zoom-to-fit when the route first appears (fresh route). On a
                // hand-edit / re-route the overlay already exists — rebuild it in
                // place without yanking the camera around after each drag.
                let isFreshRoute = nothingShown
                removeRouteOverlays(map)
                let tiers = buildTierOverlays(for: snapped)
                // Glow underlay + white casing under the colored runs so the
                // route stays a distinct, raised ribbon over the colored
                // bike-network. Added first (glow, then casing) so the tier
                // overlays paint on top of both.
                var built: [MKOverlay] = []
                if snapped.coordinates.count >= 2 {
                    built.append(RouteGlowPolyline(
                        coordinates: snapped.coordinates, count: snapped.coordinates.count
                    ))
                    built.append(RouteCasingPolyline(
                        coordinates: snapped.coordinates, count: snapped.coordinates.count
                    ))
                }
                built.append(contentsOf: tiers)
                routeOverlays = built
                map.addOverlays(built, level: .aboveLabels)
                setNetworkFaded(true, on: map)
                if isFreshRoute, let rect = unionRect(of: built) {
                    map.setVisibleMapRect(
                        rect,
                        edgePadding: UIEdgeInsets(top: 90, left: 40, bottom: 240, right: 40),
                        animated: true
                    )
                }
            }
        } else if !routeOverlays.isEmpty || editPreviewOverlay != nil {
            removeRouteOverlays(map)
        }
    }

    /// Remove all route line overlays (tier runs + any live edit preview).
    private func removeRouteOverlays(_ map: MKMapView) {
        if !routeOverlays.isEmpty {
            map.removeOverlays(routeOverlays)
            routeOverlays = []
        }
        if let preview = editPreviewOverlay {
            map.removeOverlay(preview)
            editPreviewOverlay = nil
        }
        if !manualOverlays.isEmpty {
            map.removeOverlays(manualOverlays)
            manualOverlays = []
        }
        setNetworkFaded(false, on: map)
    }

    /// Fade (or restore) the bike-network overlay's opacity. No-ops if already in
    /// the requested state; otherwise forces the network renderers to redraw.
    private func setNetworkFaded(_ faded: Bool, on map: MKMapView) {
        guard networkFaded != faded else { return }
        networkFaded = faded
        for overlay in map.overlays where overlay is BikeMultiPolyline {
            map.renderer(for: overlay)?.setNeedsDisplay()
        }
    }

    /// Build one `RouteTierPolyline` per contiguous tier run. Falls back to a
    /// single green line when the route hasn't been classified yet (tiers nil).
    private func buildTierOverlays(for snapped: SnappedRoute) -> [RouteTierPolyline] {
        let coords = snapped.coordinates
        guard coords.count >= 2 else { return [] }
        guard let tiers = snapped.tiers, tiers.count == coords.count - 1 else {
            let line = RouteTierPolyline(coordinates: coords, count: coords.count)
            line.tier = .green
            return [line]
        }

        var overlays: [RouteTierPolyline] = []
        var runStart = 0
        for i in 0..<tiers.count {
            let isLast = i == tiers.count - 1
            if isLast || tiers[i + 1] != tiers[i] {
                // Run spans route segments runStart...i → vertices runStart...i+1.
                let slice = Array(coords[runStart...(i + 1)])
                let line = RouteTierPolyline(coordinates: slice, count: slice.count)
                line.tier = tiers[i]
                overlays.append(line)
                runStart = i + 1
            }
        }
        return overlays
    }

    /// Bounding map rect covering all of `overlays`, or nil if empty.
    private func unionRect(of overlays: [MKOverlay]) -> MKMapRect? {
        guard var rect = overlays.first?.boundingMapRect else { return nil }
        for overlay in overlays.dropFirst() {
            rect = rect.union(overlay.boundingMapRect)
        }
        return rect
    }

    /// Rebuild the dashed-violet manual overlays from `store.manualSegments` so
    /// the forced (hand-drawn) stretches are visually distinct from routed ones.
    private func syncManualOverlays(_ map: MKMapView) {
        if !manualOverlays.isEmpty {
            map.removeOverlays(manualOverlays)
            manualOverlays = []
        }
        // Hide while a hand-edit drag owns the overlay (avoids a stale duplicate).
        guard !isEditing else { return }
        for seg in store.manualSegments where seg.coords.count >= 2 {
            let overlay = ManualPolyline(coordinates: seg.coords, count: seg.coords.count)
            manualOverlays.append(overlay)
            map.addOverlay(overlay, level: .aboveLabels)
        }
    }

    /// Rebuild the "route through a section" (corridor) preview: a teal highlight
    /// of the resolved street (line + white casing) plus the two tapped endpoint
    /// dots. Shown only in corridor mode; rebuilt wholesale (cheap — one street).
    private func syncCorridorPreview(_ map: MKMapView) {
        if !corridorOverlays.isEmpty {
            map.removeOverlays(corridorOverlays)
            corridorOverlays = []
        }
        if !corridorAnnotations.isEmpty {
            map.removeAnnotations(corridorAnnotations)
            corridorAnnotations = []
        }
        guard store.isCorridorMode else { return }
        if let geometry = store.corridorPreview?.geometry, geometry.count >= 2 {
            let casing = CorridorCasingPolyline(coordinates: geometry, count: geometry.count)
            let line = CorridorPolyline(coordinates: geometry, count: geometry.count)
            corridorOverlays = [casing, line]
            map.addOverlays(corridorOverlays, level: .aboveLabels)
        }
        for coordinate in [store.corridorA, store.corridorB].compactMap({ $0 }) {
            let annotation = CorridorEndpointAnnotation()
            annotation.coordinate = coordinate
            map.addAnnotation(annotation)
            corridorAnnotations.append(annotation)
        }
    }

    /// Rebuild the waypoint handle pins from `store.vias`. Shown only in edit
    /// mode (mirrors the web app). Rebuilt wholesale — the list is tiny (≤ maxVias).
    private func syncViaAnnotations(_ map: MKMapView) {
        if !viaAnnotations.isEmpty {
            map.removeAnnotations(viaAnnotations)
            viaAnnotations = []
        }
        guard store.isEditMode else { return }
        for via in store.vias {
            let annotation = ViaAnnotation()
            annotation.coordinate = via.coordinate
            annotation.precise = via.precise
            annotation.corridor = via.corridorId != nil
            map.addAnnotation(annotation)
            viaAnnotations.append(annotation)
        }
    }

    private func syncAnnotation(
        _ annotation: inout MKPointAnnotation?,
        waypoint: Waypoint?,
        title: String,
        map: MKMapView
    ) {
        if let waypoint {
            if let existing = annotation {
                existing.coordinate = waypoint.coordinate
            } else {
                let new = MKPointAnnotation()
                new.coordinate = waypoint.coordinate
                new.title = title
                map.addAnnotation(new)
                annotation = new
            }
        } else if let existing = annotation {
            map.removeAnnotation(existing)
            annotation = nil
        }
    }

    // MARK: - Tap to drop pins

    @objc func handleTap(_ gesture: UITapGestureRecognizer) {
        guard !store.isDrawMode, let map = mapView else { return }
        let point = gesture.location(in: map)
        // In edit mode, tapping a waypoint pin deletes it (and re-routes).
        if store.isEditMode, let viaIndex = nearestViaIndex(point, map: map) {
            // Optimistically drop the tapped pin so it disappears immediately.
            if viaIndex < viaAnnotations.count {
                map.removeAnnotation(viaAnnotations[viaIndex])
                viaAnnotations.remove(at: viaIndex)
            }
            Task { await store.deleteVia(at: viaIndex) }
            return
        }
        let coordinate = map.convert(point, toCoordinateFrom: map)
        store.handleMapTap(coordinate)
    }

    /// Long-press in edit mode: on a pin → toggle precise (amber/emerald); on the
    /// bare route line → drop a PRECISE anchor there (no snap) to force the route
    /// through that point. Elsewhere it's ignored (map handles its own gestures).
    @objc func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
        guard gesture.state == .began, store.isEditMode, !store.isDrawMode,
              let map = mapView else { return }
        let point = gesture.location(in: map)
        if let viaIndex = nearestViaIndex(point, map: map) {
            store.toggleViaPrecise(at: viaIndex)
            syncViaAnnotations(map) // recolor immediately
            return
        }
        guard let coords = store.snapped?.coordinates,
              nearestLineDistance(point, coords: coords, map: map)
                <= max(Self.vertexGrabPx, Self.lineGrabPx) else { return }
        let at = map.convert(point, toCoordinateFrom: map)
        Task { await store.insertPreciseVia(at) }
    }

    // MARK: - Finger draw

    @objc func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard store.isDrawMode, let map = mapView else { return }
        let point = gesture.location(in: map)

        switch gesture.state {
        case .began:
            draftCoords = []
            lastScreenPoint = nil
            appendIfFarEnough(point, map)
        case .changed:
            appendIfFarEnough(point, map)
            redrawDraft(map)
        case .ended:
            let coords = draftCoords
            removeDraft(map)
            store.commitTrace(coords)
            Task { await store.finishDrawing() }
        case .cancelled, .failed:
            removeDraft(map)
        default:
            break
        }
    }

    private func appendIfFarEnough(_ point: CGPoint, _ map: MKMapView) {
        if let last = lastScreenPoint {
            let dx = point.x - last.x
            let dy = point.y - last.y
            if (dx * dx + dy * dy) < (Self.minScreenStep * Self.minScreenStep) { return }
        }
        lastScreenPoint = point
        draftCoords.append(map.convert(point, toCoordinateFrom: map))
    }

    private func redrawDraft(_ map: MKMapView) {
        if let existing = draftOverlay { map.removeOverlay(existing) }
        guard draftCoords.count >= 2 else { return }
        let overlay = DraftPolyline(coordinates: draftCoords, count: draftCoords.count)
        draftOverlay = overlay
        map.addOverlay(overlay, level: .aboveLabels)
    }

    private func removeDraft(_ map: MKMapView) {
        if let existing = draftOverlay {
            map.removeOverlay(existing)
            draftOverlay = nil
        }
        draftCoords = []
        lastScreenPoint = nil
    }

    // MARK: - Hand-edit the route line (drag → via point → clean re-route)

    /// Drag the displayed route line to reshape it. Grabbing near an existing via
    /// moves that via; grabbing anywhere else drops a new one. During the drag we
    /// rubber-band the line for feedback; on lift the store re-routes start → vias
    /// → end cleanly along real roads (no squiggle).
    @objc func handleEditPan(_ gesture: UIPanGestureRecognizer) {
        guard let map = mapView, let snapped = store.snapped else { return }
        let point = gesture.location(in: map)

        switch gesture.state {
        case .began:
            let coords = snapped.coordinates
            // Did the touch grab an existing via? If so we'll move it; otherwise
            // the drag will drop a new via.
            editingViaIndex = nearestViaIndex(point, map: map)
            // Did the touch grab a point on a hand-drawn (manual) segment?
            let manual = manualHit(point, map: map)

            guard let hit = hitTest(point, coords: coords, map: map) else {
                // shouldBegin should have prevented this; bail safely.
                editingIndex = nil
                editingViaIndex = nil
                editingManualSegID = nil
                editingManualVertex = nil
                return
            }
            // Grabbed a manual segment → raw nudge that vertex (no via, no cap, no
            // re-route). Uses the display vertex for live preview; commits to the
            // segment's own vertex on release.
            if let manual = manual {
                editingManualSegID = manual.segID
                editingManualVertex = manual.vertex
                editingViaIndex = nil
            } else if editingViaIndex == nil && store.vias.count >= RouteStore.maxVias {
                // Refuse to add a NEW via once we're at the cap (moving an existing
                // one is always fine). Leaving isEditing false keeps the drag inert.
                editingIndex = nil
                editingManualSegID = nil
                editingManualVertex = nil
                return
            }
            switch hit {
            case .vertex(let index):
                editCoords = coords
                editingIndex = index
            case .segment(let segIndex):
                editCoords = coords
                let inserted = map.convert(point, toCoordinateFrom: map)
                let newIndex = segIndex + 1
                editCoords.insert(inserted, at: newIndex)
                editingIndex = newIndex
            }
            isEditing = true
            map.isScrollEnabled = false
            redrawEdit(map)

        case .changed:
            guard isEditing, let idx = editingIndex, idx < editCoords.count else { return }
            editCoords[idx] = map.convert(point, toCoordinateFrom: map)
            redrawEdit(map)

        case .ended:
            guard isEditing, editCoords.count >= 2,
                  let idx = editingIndex, editCoords.indices.contains(idx) else {
                isEditing = false
                editingIndex = nil
                editingViaIndex = nil
                editCoords = []
                map.isScrollEnabled = true
                return
            }
            let dragged = editCoords[idx]
            let preview = editCoords
            let viaIndex = editingViaIndex
            let manualSegID = editingManualSegID
            let manualVertex = editingManualVertex
            isEditing = false
            editingIndex = nil
            editingViaIndex = nil
            editingManualSegID = nil
            editingManualVertex = nil
            map.isScrollEnabled = true
            if let manualSegID, let manualVertex {
                // Raw-nudge the drawn segment's vertex — verbatim, no re-route.
                Task { await store.nudgeManualPoint(segmentID: manualSegID, vertexIndex: manualVertex, to: dragged) }
            } else {
                // Drop/move a via and re-route: shows the rubber-banded preview,
                // then replaces it with the clean road route.
                Task { await store.reshape(to: dragged, preview: preview, movingViaIndex: viaIndex) }
            }
            editCoords = []

        case .cancelled, .failed:
            isEditing = false
            editingIndex = nil
            editingViaIndex = nil
            editingManualSegID = nil
            editingManualVertex = nil
            editCoords = []
            map.isScrollEnabled = true
            // Rebuild the overlay from the store's untouched route.
            removeRouteOverlays(map)
            sync()

        default:
            break
        }
    }

    /// Live redraw of the edited line using the same remove+addOverlay idiom as
    /// the draft. While dragging we drop the tier colors and show a single plain
    /// preview line; sync() rebuilds the colored runs once the re-route lands.
    private func redrawEdit(_ map: MKMapView) {
        guard editCoords.count >= 2 else { return }
        removeRouteOverlays(map)
        let overlay = RoutePolyline(coordinates: editCoords, count: editCoords.count)
        editPreviewOverlay = overlay
        map.addOverlay(overlay, level: .aboveLabels)
    }

    // MARK: - Hit-testing (screen space)

    /// Index of the existing via whose screen position is within grab range of
    /// `point`, else nil. A grab near a via moves it; anywhere else drops a new one.
    private func nearestViaIndex(_ point: CGPoint, map: MKMapView) -> Int? {
        var best = Self.vertexGrabPx
        var idx: Int?
        for (i, via) in store.vias.enumerated() {
            let p = map.convert(via.coordinate, toPointTo: map)
            let d = hypot(point.x - p.x, point.y - p.y)
            if d <= best { best = d; idx = i }
        }
        return idx
    }

    /// The manual-segment vertex within grab range of `point`, else nil. Grabbing
    /// one raw-nudges it (no re-route) rather than dropping a via.
    private func manualHit(_ point: CGPoint, map: MKMapView) -> (segID: UUID, vertex: Int)? {
        var best = Self.vertexGrabPx
        var result: (UUID, Int)?
        for seg in store.manualSegments {
            for (vi, c) in seg.coords.enumerated() {
                let p = map.convert(c, toPointTo: map)
                let d = hypot(point.x - p.x, point.y - p.y)
                if d <= best { best = d; result = (seg.id, vi) }
            }
        }
        return result
    }

    private enum EditHit {
        case vertex(Int)
        case segment(Int) // index of the segment's first coordinate
    }

    /// Decide what (if anything) the touch grabbed: prefer a nearby vertex, then
    /// a nearby segment. Returns nil when the touch is too far from the line.
    private func hitTest(_ point: CGPoint, coords: [CLLocationCoordinate2D], map: MKMapView) -> EditHit? {
        guard coords.count >= 2 else { return nil }
        let screen = coords.map { map.convert($0, toPointTo: map) }

        // Nearest vertex first.
        var bestVertex = CGFloat.greatestFiniteMagnitude
        var bestVertexIndex = 0
        for (i, p) in screen.enumerated() {
            let d = hypot(point.x - p.x, point.y - p.y)
            if d < bestVertex { bestVertex = d; bestVertexIndex = i }
        }
        if bestVertex <= Self.vertexGrabPx {
            return .vertex(bestVertexIndex)
        }

        // Otherwise nearest segment.
        var bestSeg = CGFloat.greatestFiniteMagnitude
        var bestSegIndex = 0
        for i in 0..<(screen.count - 1) {
            let d = pointToSegmentDistance(point, screen[i], screen[i + 1])
            if d < bestSeg { bestSeg = d; bestSegIndex = i }
        }
        if bestSeg <= Self.lineGrabPx {
            return .segment(bestSegIndex)
        }
        return nil
    }

    /// Shortest distance, in screen points, from `p` to whichever was closest of
    /// the route's vertices or segments. Used by gestureRecognizerShouldBegin.
    private func nearestLineDistance(_ p: CGPoint, coords: [CLLocationCoordinate2D], map: MKMapView) -> CGFloat {
        guard coords.count >= 2 else { return .greatestFiniteMagnitude }
        let screen = coords.map { map.convert($0, toPointTo: map) }
        var best = CGFloat.greatestFiniteMagnitude
        for pt in screen {
            best = min(best, hypot(p.x - pt.x, p.y - pt.y))
        }
        for i in 0..<(screen.count - 1) {
            best = min(best, pointToSegmentDistance(p, screen[i], screen[i + 1]))
        }
        return best
    }

    // MARK: - Location

    /// Ask for when-in-use permission. Showing the blue dot requires this —
    /// setting `showsUserLocation` alone never prompts.
    func requestLocationPermission() {
        if locationManager.authorizationStatus == .notDetermined {
            locationManager.requestWhenInUseAuthorization()
        }
    }

    /// Recenter the map on the user's current location. If we don't have a fix
    /// yet, remember the request and recenter once the first location arrives.
    private func recenterOnUser(_ map: MKMapView) {
        if let coordinate = map.userLocation.location?.coordinate {
            let region = MKCoordinateRegion(
                center: coordinate,
                span: MKCoordinateSpan(latitudeDelta: 0.02, longitudeDelta: 0.02)
            )
            map.setRegion(region, animated: true)
            pendingRecenter = false
        } else {
            pendingRecenter = true
            requestLocationPermission()
        }
    }

    /// Set the route start to the user's current location. If we don't have a
    /// fix yet, remember the request and apply it once the first location lands.
    private func useCurrentLocationAsStart(_ map: MKMapView) {
        if let coordinate = map.userLocation.location?.coordinate {
            pendingUseLocationStart = false
            setStartFromLocation(coordinate)
            recenterOnUser(map)
        } else {
            pendingUseLocationStart = true
            requestLocationPermission()
        }
    }

    /// Drop the start pin at `coordinate`. Deferred off the SwiftUI update pass
    /// (sync() runs inside updateUIView) so we never mutate the store mid-render.
    private func setStartFromLocation(_ coordinate: CLLocationCoordinate2D) {
        Task { @MainActor [store] in
            store.setPin(coordinate, kind: .start, label: "My location")
        }
    }

    /// Once the user's location lands, honor any pending recenter / use-as-start.
    func mapView(_ mapView: MKMapView, didUpdate userLocation: MKUserLocation) {
        guard userLocation.location != nil else { return }
        if pendingRecenter {
            recenterOnUser(mapView)
        }
        if pendingUseLocationStart, let coordinate = userLocation.location?.coordinate {
            pendingUseLocationStart = false
            setStartFromLocation(coordinate)
            recenterOnUser(mapView)
        }
    }

    // MARK: - MKMapViewDelegate

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        switch overlay {
        case let polyline as RouteGlowPolyline:
            // Wide, low-alpha underlay faking a soft outer glow (no real blur in
            // MKPolylineRenderer) so the route lifts off the basemap.
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor(white: 0.06, alpha: 0.22)
            renderer.lineWidth = 16
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        case let polyline as RouteCasingPolyline:
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = .white
            renderer.lineWidth = 11
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        case let polyline as RouteTierPolyline:
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = polyline.tier.color
            renderer.lineWidth = 6
            renderer.lineCap = .round
            renderer.lineJoin = .round
            if polyline.tier.dashed { renderer.lineDashPattern = [2, 10] }
            return renderer
        case let polyline as RoutePolyline:
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = .systemBlue
            renderer.lineWidth = 6
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        case let polyline as ManualPolyline:
            // Forced (hand-drawn) stretch: dashed violet over the tier route.
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor(red: 0.545, green: 0.361, blue: 0.965, alpha: 1) // #8B5CF6
            renderer.lineWidth = 5
            renderer.lineCap = .round
            renderer.lineJoin = .round
            renderer.lineDashPattern = [2, 8]
            return renderer
        case let polyline as CorridorCasingPolyline:
            // White casing under the teal corridor highlight (mirrors the web).
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor.white.withAlphaComponent(0.9)
            renderer.lineWidth = 9
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        case let polyline as CorridorPolyline:
            // The picked "route through a section" street, highlighted in teal.
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 1) // #0d9488 teal
            renderer.lineWidth = 5
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        case let polyline as DraftPolyline:
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor.systemBlue.withAlphaComponent(0.45)
            renderer.lineWidth = 5
            renderer.lineDashPattern = [2, 8]
            renderer.lineCap = .round
            return renderer
        case let multi as BikeMultiPolyline:
            let renderer = MKMultiPolylineRenderer(multiPolyline: multi)
            // Fade the network back while a route is displayed so the route owns
            // the foreground (its green tier ≈ the greenway color).
            renderer.strokeColor = multi.bikeClass.color
                .withAlphaComponent(networkFaded ? 0.35 : 0.85)
            renderer.lineWidth = multi.bikeClass.lineWidth
            renderer.lineCap = .round
            renderer.lineJoin = .round
            if multi.bikeClass.dashed { renderer.lineDashPattern = [3, 6] }
            return renderer
        case let polyline as GreenwayPolyline:
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor.systemGreen.withAlphaComponent(0.7)
            renderer.lineWidth = 4
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        default:
            return MKOverlayRenderer(overlay: overlay)
        }
    }

    func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
        if annotation is MKUserLocation { return nil }

        // Waypoint handle: a small emerald dot with a white ring. Non-interactive
        // so touches pass through to the edit-pan / tap gestures on the line.
        if let via = annotation as? ViaAnnotation {
            let id = "via"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: id)
                ?? MKAnnotationView(annotation: annotation, reuseIdentifier: id)
            view.annotation = annotation
            let size: CGFloat = via.precise ? 18 : 16
            view.frame = CGRect(x: 0, y: 0, width: size, height: size)
            view.backgroundColor = .clear
            view.layer.cornerRadius = size / 2
            // Corridor handles read teal; precise (forced) anchors amber; normal
            // snap waypoints emerald (mirrors the web waypoint palette).
            let fill: UIColor
            if via.corridor {
                fill = UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 1) // #0d9488 teal
            } else if via.precise {
                fill = UIColor(red: 0.961, green: 0.620, blue: 0.043, alpha: 1) // #f59e0b amber
            } else {
                fill = UIColor(red: 0.063, green: 0.725, blue: 0.506, alpha: 1) // #10b981 emerald
            }
            view.layer.backgroundColor = fill.cgColor
            view.layer.borderColor = UIColor.white.cgColor
            view.layer.borderWidth = 2.5
            view.canShowCallout = false
            view.isUserInteractionEnabled = false
            return view
        }

        // Corridor endpoint (A/B): a teal dot with a white ring marking a tapped
        // end of the picked section. Non-interactive so the second tap reaches
        // the map's tap gesture (which resolves the street).
        if annotation is CorridorEndpointAnnotation {
            let id = "corridorEndpoint"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: id)
                ?? MKAnnotationView(annotation: annotation, reuseIdentifier: id)
            view.annotation = annotation
            let size: CGFloat = 18
            view.frame = CGRect(x: 0, y: 0, width: size, height: size)
            view.backgroundColor = .clear
            view.layer.cornerRadius = size / 2
            view.layer.backgroundColor = UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 1).cgColor // #0d9488 teal
            view.layer.borderColor = UIColor.white.cgColor
            view.layer.borderWidth = 3
            view.canShowCallout = false
            view.isUserInteractionEnabled = false
            return view
        }

        let identifier = "waypoint"
        let view = (mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
            as? MKMarkerAnnotationView)
            ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: identifier)
        view.annotation = annotation
        // Draggable so the user can nudge an endpoint onto the real driveway.
        view.isDraggable = true

        let title = (annotation.title ?? nil) ?? ""
        if title == "Start" {
            view.markerTintColor = .systemGreen
            view.glyphImage = UIImage(systemName: "figure.outdoor.cycle")
        } else {
            view.markerTintColor = .systemRed
            view.glyphImage = UIImage(systemName: "flag.checkered")
        }
        return view
    }

    /// Dragged the start/end marker → update that endpoint (re-routes through any
    /// existing waypoints, which persist).
    func mapView(
        _ mapView: MKMapView,
        annotationView view: MKAnnotationView,
        didChange newState: MKAnnotationView.DragState,
        fromOldState oldState: MKAnnotationView.DragState
    ) {
        guard newState == .ending || newState == .canceling else { return }
        view.dragState = .none
        guard let annotation = view.annotation as? MKPointAnnotation else { return }
        let kind: WaypointKind
        if annotation === startAnnotation {
            kind = .start
        } else if annotation === endAnnotation {
            kind = .end
        } else {
            return
        }
        store.setPin(annotation.coordinate, kind: kind, label: "Adjusted pin")
    }

    // MARK: - UIGestureRecognizerDelegate

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool {
        true
    }

    /// Only let the edit-pan begin when the touch lands on the route line; this
    /// gives it priority over the map's own pan there, while letting the map
    /// scroll normally everywhere else. Other gestures begin as usual.
    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === editPanGesture else { return true }
        guard let map = mapView, let coords = store.snapped?.coordinates, !store.isDrawMode else {
            return false
        }
        let point = gestureRecognizer.location(in: map)
        let grab = max(Self.vertexGrabPx, Self.lineGrabPx)
        return nearestLineDistance(point, coords: coords, map: map) <= grab
    }
}

/// A drag-to-reshape waypoint handle. Subclass so `viewFor` can render it as a
/// distinct dot (vs. the start/end marker pins) — emerald for snap waypoints,
/// amber for precise (forced, non-snapping) anchors.
final class ViaAnnotation: MKPointAnnotation {
    var precise = false
    /// True when this handle belongs to a "route through a section" corridor —
    /// rendered teal (like the web) to read as part of a picked section.
    var corridor = false
}

/// A tapped endpoint (A or B) of a "route through a section" pick. Subclass so
/// `viewFor` can render it as a distinct teal dot while the section is chosen.
final class CorridorEndpointAnnotation: MKPointAnnotation {}

/// Shortest distance from point `p` to the line segment `a`–`b`, in the same
/// (screen) coordinate space. Free function — pure CGPoint math.
private func pointToSegmentDistance(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
    let dx = b.x - a.x
    let dy = b.y - a.y
    let lenSq = dx * dx + dy * dy
    if lenSq == 0 { return hypot(p.x - a.x, p.y - a.y) }
    var t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq
    t = max(0, min(1, t))
    let projX = a.x + t * dx
    let projY = a.y + t * dy
    return hypot(p.x - projX, p.y - projY)
}
