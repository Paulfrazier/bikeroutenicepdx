import MapKit
import UIKit

/// MKMapView delegate + gesture handling for the draw-a-route map.
/// MainActor-isolated because all MapKit/UIKit interaction happens on main.
@MainActor
final class MapCoordinator: NSObject, MKMapViewDelegate, UIGestureRecognizerDelegate {
    var store: RouteStore
    /// Live navigation state. Set from MapView.updateUIView; drives the chase
    /// camera in syncNav() and suppresses the planner gestures while riding.
    var nav: NavigationSession?
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
    /// Dashed-violet overlays marking the hand-drawn (manual) stretches. Unused now
    /// that Draw strokes ARE the route (rendered as the colored line); kept so
    /// `removeRouteOverlays` stays a safe no-op.
    private var manualOverlays: [ManualPolyline] = []
    /// The violet "pen" marker at the resume point (last vertex of the last Draw
    /// stroke), shown only in Draw mode so the rider sees where drawing continues.
    private var penAnnotation: DrawPenAnnotation?
    /// Teal highlight (line + white casing) of the picked "route through a
    /// section" street, shown only while in corridor mode.
    private var corridorOverlays: [MKOverlay] = []
    /// The two tapped corridor endpoints (A, B), shown as teal dots while picking.
    private var corridorAnnotations: [CorridorEndpointAnnotation] = []
    /// Persistent teal "your fix" overlays for every connector (personal +
    /// community), shown regardless of whether a route is on screen.
    private var connectorOverlays: [MKOverlay] = []
    /// Teal node dots + dashed draft line for the connector currently being built
    /// by tapping (connector-build mode). Rebuilt wholesale on each tap.
    private var connectorNodeAnnotations: [ConnectorNodeAnnotation] = []
    private var connectorDraftOverlay: ConnectorDraftPolyline?
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

    // Live Draw-mode vertex-nudge state: when a draw-stroke begins on an existing
    // stroke vertex we nudge that vertex (raw, no re-snap) instead of starting a
    // fresh stroke. Mirrors the web `startVertexNudge` branch of `onDown`.
    private var drawNudgeSegID: UUID?
    private var drawNudgeVertex: Int?
    private var drawNudgeCoords: [CLLocationCoordinate2D] = []

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

        // Persistent "your fix" connector overlays — always reconciled (even while
        // navigating) so a freshly drawn/deleted fix appears/disappears at once.
        // (finishDrawing toggles isConnectorDrawMode/isDrawMode → updateUIView →
        // sync(), so adding a connector with no route still refreshes this.)
        syncConnectorOverlays(map)

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

        // While navigating, the chase camera owns the map: suppress every planner
        // gesture (a tap must not drop a pin, the line must not be draggable) but
        // still rebuild overlays below so a live reroute updates the route line.
        if nav?.isNavigating == true {
            map.isScrollEnabled = true
            map.isZoomEnabled = true
            map.isRotateEnabled = false
            map.isPitchEnabled = false
            panGesture?.isEnabled = false
            tapGesture?.isEnabled = false
            editPanGesture?.isEnabled = false
            editLongPressGesture?.isEnabled = false
            syncAnnotation(&startAnnotation, waypoint: store.start, title: "Start", map: map)
            syncAnnotation(&endAnnotation, waypoint: store.end, title: "End", map: map)
            syncRouteOverlays(map)
            return
        }

        // Lock map interaction while drawing (Draw mode) so our pan gesture owns the
        // touch. Draw is the only freehand mode now (the old Build+Snap-off sketch
        // is retired); taps are disabled so a drag isn't read as a waypoint tap.
        // While Draw is PAUSED ("✋ Move map") the pan gesture stands down so the map
        // scrolls/zooms normally; taps stay inert (handleTap guards !isDrawMode).
        let freehand = store.isDrawMode && !store.isDrawPaused
        map.isScrollEnabled = !freehand
        map.isZoomEnabled = !freehand
        map.isRotateEnabled = !freehand
        map.isPitchEnabled = !freehand
        panGesture?.isEnabled = freehand
        tapGesture?.isEnabled = !freehand

        // Hand-edit pan is live when a finished route is on screen, we're not
        // drawing, AND we're in Drag (reshape the line) OR Build (drag a pin to move
        // it). Off in corridor mode so taps pick the section. shouldBegin further
        // gates it: in Drag to touches on the line, in Build to touches on a pin.
        editPanGesture?.isEnabled = (
            store.snapped != nil && !freehand
            && (store.isEditMode || store.isBuildMode) && !store.isCorridorMode
        )

        syncAnnotation(&startAnnotation, waypoint: store.start, title: "Start", map: map)
        syncAnnotation(&endAnnotation, waypoint: store.end, title: "End", map: map)
        syncViaAnnotations(map)
        syncDrawPen(map)
        syncCorridorPreview(map)
        syncConnectorBuild(map)

        syncRouteOverlays(map)
    }

    /// Rebuild the route line overlays when the route identity changes. Zoom-to-fit
    /// only on a fresh route and never while navigating (the chase camera owns the
    /// viewport then). Shared by the planner path and the nav branch of sync().
    private func syncRouteOverlays(_ map: MKMapView) {
        if let snapped = store.snapped {
            // Rebuild when the route identity changes (routeVersion), not just its
            // point count — a re-snap can return the same count as the raw line it
            // replaces, which a count check would miss.
            let nothingShown = routeOverlays.isEmpty && editPreviewOverlay == nil
            let needsUpdate = nothingShown || store.routeVersion != lastRouteVersion
            lastRouteVersion = store.routeVersion
            if needsUpdate {
                // Only zoom-to-fit when the route first appears (fresh route) AND
                // we're not navigating. On a hand-edit / re-route / live reroute the
                // overlay already exists — rebuild it in place without yanking the
                // camera around.
                let isFreshRoute = nothingShown && nav?.isNavigating != true
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

    // MARK: - Navigation chase camera

    private var lastNavFixVersion = -1
    private var navCameraActive = false

    /// Drive the chase camera while navigating: re-center on each new GPS fix,
    /// oriented to the rider's course, pitched into a 3D forward view. On exit,
    /// restore a flat north-up camera.
    func syncNav() {
        guard let map = mapView else { return }
        guard let nav, nav.isNavigating else {
            if navCameraActive {
                navCameraActive = false
                lastNavFixVersion = -1
                let camera = MKMapCamera()
                camera.centerCoordinate = map.centerCoordinate
                camera.heading = 0
                camera.pitch = 0
                camera.centerCoordinateDistance = 2200
                map.setCamera(camera, animated: true)
            }
            return
        }
        navCameraActive = true
        guard nav.fixVersion != lastNavFixVersion, let center = nav.currentLocation else { return }
        lastNavFixVersion = nav.fixVersion
        let camera = MKMapCamera()
        camera.centerCoordinate = center
        camera.heading = nav.course
        camera.pitch = 30   // was 55 — gentler tilt so the route ahead stays legible
        camera.centerCoordinateDistance = 340
        map.setCamera(camera, animated: true)
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

    /// Build one `RouteTierPolyline` per contiguous facility-class run. Falls back
    /// to a single quiet-street line when the route hasn't been classified yet.
    private func buildTierOverlays(for snapped: SnappedRoute) -> [RouteTierPolyline] {
        let coords = snapped.coordinates
        guard coords.count >= 2 else { return [] }
        guard let classes = snapped.routeClasses, classes.count == coords.count - 1 else {
            let line = RouteTierPolyline(coordinates: coords, count: coords.count)
            line.routeClass = .quiet
            return [line]
        }

        var overlays: [RouteTierPolyline] = []
        var runStart = 0
        for i in 0..<classes.count {
            let isLast = i == classes.count - 1
            if isLast || classes[i + 1] != classes[i] {
                // Run spans route segments runStart...i → vertices runStart...i+1.
                let slice = Array(coords[runStart...(i + 1)])
                let line = RouteTierPolyline(coordinates: slice, count: slice.count)
                line.routeClass = classes[i]
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

    /// Reconcile the violet "pen" marker — the resume point (last vertex of the last
    /// Draw stroke), shown only in Draw mode so the rider sees where the next stroke
    /// continues from. Mirrors the web `draw-pen` layer.
    private func syncDrawPen(_ map: MKMapView) {
        let penCoord: CLLocationCoordinate2D? = store.isDrawMode
            ? store.manualSegments.last(where: { !$0.coords.isEmpty })?.coords.last
            : nil
        if let penCoord {
            if let existing = penAnnotation {
                existing.coordinate = penCoord
            } else {
                let annotation = DrawPenAnnotation()
                annotation.coordinate = penCoord
                map.addAnnotation(annotation)
                penAnnotation = annotation
            }
        } else if let existing = penAnnotation {
            map.removeAnnotation(existing)
            penAnnotation = nil
        }
    }

    /// Rebuild the persistent teal "your fix" overlays from the bundled community
    /// fixes + the rider's personal connectors. Always shown (a global map-fix
    /// layer), beneath the planned route. Cheap — rebuilt wholesale (a handful of
    /// short lines). Pre-cleaned (<2-point lines dropped) by the loaders.
    private func syncConnectorOverlays(_ map: MKMapView) {
        if !connectorOverlays.isEmpty {
            map.removeOverlays(connectorOverlays)
            connectorOverlays = []
        }
        var lines = CommunityConnectors.lines()
        lines.append(contentsOf: Connectors.list().map { $0.coords })
        var built: [MKOverlay] = []
        for coords in lines where coords.count >= 2 {
            built.append(ConnectorGlowPolyline(coordinates: coords, count: coords.count))
            built.append(ConnectorPolyline(coordinates: coords, count: coords.count))
        }
        connectorOverlays = built
        // .aboveRoads (like the bike-network overlay) sits strictly beneath the
        // planned route (.aboveLabels), so the route always reads as foreground;
        // added after the network so the fix paints on top of it.
        if !built.isEmpty { map.addOverlays(built, level: .aboveRoads) }
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

    /// Rebuild the waypoint handle pins from `store.vias`. Shown in Drag, Build, and
    /// Through (so the rider can see picked sections and tap one to remove it) —
    /// mirrors the web `editing || buildMode || corridorMode` visibility. Rebuilt
    /// wholesale — the list is tiny (≤ maxVias).
    private func syncViaAnnotations(_ map: MKMapView) {
        if !viaAnnotations.isEmpty {
            map.removeAnnotations(viaAnnotations)
            viaAnnotations = []
        }
        guard store.isEditMode || store.isBuildMode || store.isCorridorMode else { return }
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
        // Connector-build mode owns the tap: hit an existing node → remove it;
        // tap anywhere else → append a node (tap order). The map stays interactive
        // so the rider can pan/zoom between taps to place precise link ends.
        if store.isConnectorDrawMode {
            if let nodeIndex = nearestConnectorNodeIndex(point, map: map) {
                store.removeConnectorNode(at: nodeIndex)
            } else {
                store.addConnectorPoint(map.convert(point, toCoordinateFrom: map))
            }
            return
        }
        // Build (guided-draw) mode owns the tap: hit a waypoint pin → remove it;
        // tap anywhere else → append a new waypoint (tap order). The from/to pin
        // cycle is bypassed while building. (A drag on a pin moves it via editPan.)
        if store.isBuildMode {
            if let viaIndex = nearestViaIndex(point, map: map) {
                if viaIndex < viaAnnotations.count {
                    map.removeAnnotation(viaAnnotations[viaIndex])
                    viaAnnotations.remove(at: viaIndex)
                }
                Task { await store.deleteVia(at: viaIndex) }
            } else {
                let coordinate = map.convert(point, toCoordinateFrom: map)
                Task { await store.addWaypoint(coordinate) }
            }
            return
        }
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
        // Through (corridor) mode: tapping an existing section's pin removes that
        // whole section (deleteVia drops the entire corridorId group); otherwise the
        // tap falls through to handleMapTap's two-tap A→B pick. Mirrors the web.
        if store.isCorridorMode, let viaIndex = nearestViaIndex(point, map: map) {
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
        guard gesture.state == .began, !store.isDrawMode, nav?.isNavigating != true,
              let map = mapView else { return }
        let point = gesture.location(in: map)

        // Outside edit mode a long-press rates the street under the finger (the
        // least intrusive home for it — edit mode already claims long-press for
        // precise anchors, and the planner tap drops pins). Resolve the street
        // and let RootView present the four-way rating dialog.
        if !store.isEditMode {
            guard !store.isCorridorMode else { return }
            let coordinate = map.convert(point, toCoordinateFrom: map)
            store.requestRating(at: coordinate)
            return
        }
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

    /// Draw mode pan. Two behaviours, branched at `.began` (mirrors the web `onDown`
    /// Draw branch): grabbing on an existing stroke vertex NUDGES it (raw, no
    /// re-snap, via `nudgeManualPoint`); anywhere else starts a fresh (resumable)
    /// stroke that's snapped to roads and appended on lift.
    @objc func handlePan(_ gesture: UIPanGestureRecognizer) {
        guard store.isDrawMode, let map = mapView else { return }
        let point = gesture.location(in: map)

        switch gesture.state {
        case .began:
            // Grab a stroke vertex to nudge it; else start a new stroke.
            if let manual = manualHit(point, map: map),
               let seg = store.manualSegments.first(where: { $0.id == manual.segID }) {
                drawNudgeSegID = manual.segID
                drawNudgeVertex = manual.vertex
                drawNudgeCoords = seg.coords
                isEditing = true // freeze sync() so the route isn't rebuilt mid-nudge
                redrawDrawNudge(map)
            } else {
                drawNudgeSegID = nil
                draftCoords = []
                lastScreenPoint = nil
                appendIfFarEnough(point, map)
            }
        case .changed:
            if drawNudgeSegID != nil, let vi = drawNudgeVertex, drawNudgeCoords.indices.contains(vi) {
                drawNudgeCoords[vi] = map.convert(point, toCoordinateFrom: map)
                redrawDrawNudge(map)
            } else {
                appendIfFarEnough(point, map)
                redrawDraft(map)
            }
        case .ended:
            if let segID = drawNudgeSegID, let vi = drawNudgeVertex, drawNudgeCoords.indices.contains(vi) {
                let to = drawNudgeCoords[vi]
                drawNudgeSegID = nil
                drawNudgeVertex = nil
                drawNudgeCoords = []
                isEditing = false
                if let preview = editPreviewOverlay {
                    map.removeOverlay(preview)
                    editPreviewOverlay = nil
                }
                Task { await store.nudgeManualPoint(segmentID: segID, vertexIndex: vi, to: to) }
            } else {
                let coords = draftCoords
                removeDraft(map)
                Task { await store.addDrawnStroke(coords) }
            }
        case .cancelled, .failed:
            if drawNudgeSegID != nil {
                drawNudgeSegID = nil
                drawNudgeVertex = nil
                drawNudgeCoords = []
                isEditing = false
                if let preview = editPreviewOverlay {
                    map.removeOverlay(preview)
                    editPreviewOverlay = nil
                }
            } else {
                removeDraft(map)
            }
        default:
            break
        }
    }

    /// Live preview of the single stroke being nudged in Draw mode — a plain blue
    /// line over the (frozen) colored route, replaced once the re-splice lands.
    private func redrawDrawNudge(_ map: MKMapView) {
        if let existing = editPreviewOverlay {
            map.removeOverlay(existing)
            editPreviewOverlay = nil
        }
        guard drawNudgeCoords.count >= 2 else { return }
        let overlay = RoutePolyline(coordinates: drawNudgeCoords, count: drawNudgeCoords.count)
        editPreviewOverlay = overlay
        map.addOverlay(overlay, level: .aboveLabels)
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

            // Build mode only MOVES an existing pin (taps add/remove waypoints); a
            // bare-line drag must not insert a new via.
            if store.isBuildMode && editingViaIndex == nil {
                editingIndex = nil
                editingViaIndex = nil
                editingManualSegID = nil
                editingManualVertex = nil
                return
            }
            // Drag mode over a hand-drawn route: only stroke-vertex nudges edit it
            // (a bare-line drag is inert, mirroring the web `drawnStrokes` branch).
            if store.isEditMode && manual == nil && !store.manualSegments.isEmpty {
                editingIndex = nil
                editingViaIndex = nil
                editingManualSegID = nil
                editingManualVertex = nil
                return
            }

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

    /// Index of the connector-build node within grab range of `point`, else nil. A
    /// tap near a node removes it; anywhere else appends a new one.
    private func nearestConnectorNodeIndex(_ point: CGPoint, map: MKMapView) -> Int? {
        var best = Self.vertexGrabPx
        var idx: Int?
        for (i, coord) in store.connectorPoints.enumerated() {
            let p = map.convert(coord, toPointTo: map)
            let d = hypot(point.x - p.x, point.y - p.y)
            if d <= best { best = d; idx = i }
        }
        return idx
    }

    /// Rebuild the in-progress connector's node dots + dashed draft line from
    /// `store.connectorPoints`. Shown only in connector-build mode; rebuilt
    /// wholesale on each tap (the node list is tiny).
    private func syncConnectorBuild(_ map: MKMapView) {
        if !connectorNodeAnnotations.isEmpty {
            map.removeAnnotations(connectorNodeAnnotations)
            connectorNodeAnnotations = []
        }
        if let existing = connectorDraftOverlay {
            map.removeOverlay(existing)
            connectorDraftOverlay = nil
        }
        guard store.isConnectorDrawMode else { return }
        let coords = store.connectorPoints
        if coords.count >= 2 {
            let overlay = ConnectorDraftPolyline(coordinates: coords, count: coords.count)
            connectorDraftOverlay = overlay
            map.addOverlay(overlay, level: .aboveLabels)
        }
        for (i, coord) in coords.enumerated() {
            let annotation = ConnectorNodeAnnotation()
            annotation.coordinate = coord
            // The first + last node are the link ends (what gets attached to the
            // road network) → drawn larger so they read as the meaningful ends.
            annotation.isEnd = (i == 0 || i == coords.count - 1)
            map.addAnnotation(annotation)
            connectorNodeAnnotations.append(annotation)
        }
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
            renderer.strokeColor = polyline.routeClass.color
            renderer.lineWidth = 6
            renderer.lineCap = .round
            renderer.lineJoin = .round
            if polyline.routeClass.dashed { renderer.lineDashPattern = [2, 10] }
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
        case let polyline as ConnectorGlowPolyline:
            // Wide, low-alpha teal underlay faking a soft glow under the fix line.
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 0.25) // #0d9488
            renderer.lineWidth = 11
            renderer.lineCap = .round
            renderer.lineJoin = .round
            return renderer
        case let polyline as ConnectorPolyline:
            // Persistent "your fix" connector, solid teal (#0d9488 — matches the
            // web connector overlay + the corridor highlight).
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 1) // #0d9488
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
        case let polyline as ConnectorDraftPolyline:
            // The in-progress (tap-built) connector: dashed teal, reading as a draft
            // of the solid teal fixes already saved on the map.
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 0.9) // #0d9488
            renderer.lineWidth = 5
            renderer.lineDashPattern = [2, 8]
            renderer.lineCap = .round
            renderer.lineJoin = .round
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

        // Draw "pen": a larger violet dot marking the resume point (where the next
        // Draw stroke continues from). Non-interactive so the draw pan owns touches.
        if annotation is DrawPenAnnotation {
            let id = "drawPen"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: id)
                ?? MKAnnotationView(annotation: annotation, reuseIdentifier: id)
            view.annotation = annotation
            let size: CGFloat = 18
            view.frame = CGRect(x: 0, y: 0, width: size, height: size)
            view.backgroundColor = .clear
            view.layer.cornerRadius = size / 2
            view.layer.backgroundColor = UIColor(red: 0.486, green: 0.227, blue: 0.929, alpha: 1).cgColor // #7c3aed
            view.layer.borderColor = UIColor.white.cgColor
            view.layer.borderWidth = 3
            view.canShowCallout = false
            view.isUserInteractionEnabled = false
            return view
        }

        // Connector-build node: a teal dot the rider tapped to trace a fix. The
        // link ends (first/last) are larger with a heavier ring; intermediate
        // nodes are smaller. Non-interactive so the next tap reaches the map's tap
        // gesture (which appends/removes a node).
        if let node = annotation as? ConnectorNodeAnnotation {
            let id = "connectorNode"
            let view = mapView.dequeueReusableAnnotationView(withIdentifier: id)
                ?? MKAnnotationView(annotation: annotation, reuseIdentifier: id)
            view.annotation = annotation
            let size: CGFloat = node.isEnd ? 18 : 13
            view.frame = CGRect(x: 0, y: 0, width: size, height: size)
            view.backgroundColor = .clear
            view.layer.cornerRadius = size / 2
            view.layer.backgroundColor = UIColor(red: 0.051, green: 0.580, blue: 0.533, alpha: 1).cgColor // #0d9488 teal
            view.layer.borderColor = UIColor.white.cgColor
            view.layer.borderWidth = node.isEnd ? 3 : 2
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
        // Build mode: only begin to MOVE a pin (taps own add/remove); a drag off any
        // pin must fall through to the map so it pans normally.
        if store.isBuildMode {
            return nearestViaIndex(point, map: map) != nil
        }
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

/// The Draw-mode "pen" marker — the resume point (last vertex of the last drawn
/// stroke). Subclass so `viewFor` renders it as a distinct violet dot.
final class DrawPenAnnotation: MKPointAnnotation {}

/// A tapped node of the connector being built (connector-build mode). `isEnd`
/// marks the first/last node — the link ends — so `viewFor` draws them larger.
final class ConnectorNodeAnnotation: MKPointAnnotation {
    var isEnd = false
}

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
