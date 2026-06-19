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

    private let locationManager = CLLocationManager()
    private var lastRecenterTick = 0
    private var pendingRecenter = false
    private var lastRouteVersion = 0

    private var startAnnotation: MKPointAnnotation?
    private var endAnnotation: MKPointAnnotation?
    private var routeOverlay: RoutePolyline?

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

        // Lock map interaction while drawing so our pan gesture owns the touch.
        let drawing = store.isDrawMode
        map.isScrollEnabled = !drawing
        map.isZoomEnabled = !drawing
        map.isRotateEnabled = !drawing
        map.isPitchEnabled = !drawing
        panGesture?.isEnabled = drawing
        tapGesture?.isEnabled = !drawing

        // Hand-edit pan is live only when a finished route is on screen and we're
        // not drawing. shouldBegin further gates it to touches that land on the line.
        editPanGesture?.isEnabled = (store.snapped != nil && !drawing)

        syncAnnotation(&startAnnotation, waypoint: store.start, title: "Start", map: map)
        syncAnnotation(&endAnnotation, waypoint: store.end, title: "End", map: map)

        if let snapped = store.snapped {
            // Rebuild when the route identity changes (routeVersion), not just its
            // point count — a re-snap can return the same count as the raw line it
            // replaces, which a count check would miss.
            let needsUpdate = routeOverlay == nil || store.routeVersion != lastRouteVersion
            lastRouteVersion = store.routeVersion
            if needsUpdate {
                // Only zoom-to-fit when the route first appears (fresh draw). On a
                // hand-edit the overlay already exists — rebuild it in place without
                // yanking the camera around after each drag.
                let isFreshRoute = routeOverlay == nil
                if let existing = routeOverlay { map.removeOverlay(existing) }
                let overlay = RoutePolyline(
                    coordinates: snapped.coordinates,
                    count: snapped.coordinates.count
                )
                routeOverlay = overlay
                map.addOverlay(overlay, level: .aboveLabels)
                if isFreshRoute {
                    map.setVisibleMapRect(
                        overlay.boundingMapRect,
                        edgePadding: UIEdgeInsets(top: 90, left: 40, bottom: 240, right: 40),
                        animated: true
                    )
                }
            }
        } else if let existing = routeOverlay {
            map.removeOverlay(existing)
            routeOverlay = nil
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
        let coordinate = map.convert(point, toCoordinateFrom: map)
        store.handleMapTap(coordinate)
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

    // MARK: - Hand-edit the route line (raw, no re-snapping)

    /// Drag the displayed route line wherever the finger goes — no /match call.
    /// Grabbing near a vertex moves it; grabbing along a segment inserts a new
    /// vertex there and drags that. On lift we commit the raw coordinates.
    @objc func handleEditPan(_ gesture: UIPanGestureRecognizer) {
        guard let map = mapView, let snapped = store.snapped else { return }
        let point = gesture.location(in: map)

        switch gesture.state {
        case .began:
            let coords = snapped.coordinates
            guard let hit = hitTest(point, coords: coords, map: map) else {
                // shouldBegin should have prevented this; bail safely.
                editingIndex = nil
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
            guard isEditing, editCoords.count >= 2 else {
                isEditing = false
                editingIndex = nil
                editCoords = []
                map.isScrollEnabled = true
                return
            }
            let coords = editCoords
            isEditing = false
            editingIndex = nil
            map.isScrollEnabled = true
            // Async re-snap: shows the raw line instantly, then tightens it onto
            // roads. sync() rebuilds the overlay from snapped on each update.
            Task { await store.commitEdit(coords) }
            editCoords = []

        case .cancelled, .failed:
            isEditing = false
            editingIndex = nil
            editCoords = []
            map.isScrollEnabled = true
            // Rebuild the overlay from the store's untouched route.
            if let existing = routeOverlay { map.removeOverlay(existing) }
            routeOverlay = nil
            sync()

        default:
            break
        }
    }

    /// Live redraw of the edited line using the same remove+addOverlay idiom as
    /// the draft. Reuses `routeOverlay` so the renderer styling is unchanged.
    private func redrawEdit(_ map: MKMapView) {
        guard editCoords.count >= 2 else { return }
        if let existing = routeOverlay { map.removeOverlay(existing) }
        let overlay = RoutePolyline(coordinates: editCoords, count: editCoords.count)
        routeOverlay = overlay
        map.addOverlay(overlay, level: .aboveLabels)
    }

    // MARK: - Hit-testing (screen space)

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

    /// Once the user's location lands, honor any pending recenter request.
    func mapView(_ mapView: MKMapView, didUpdate userLocation: MKUserLocation) {
        guard pendingRecenter, userLocation.location != nil else { return }
        recenterOnUser(mapView)
    }

    // MARK: - MKMapViewDelegate

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        switch overlay {
        case let polyline as RoutePolyline:
            let renderer = MKPolylineRenderer(polyline: polyline)
            renderer.strokeColor = .systemBlue
            renderer.lineWidth = 6
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
            renderer.strokeColor = multi.bikeClass.color.withAlphaComponent(0.85)
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
        let identifier = "waypoint"
        let view = (mapView.dequeueReusableAnnotationView(withIdentifier: identifier)
            as? MKMarkerAnnotationView)
            ?? MKMarkerAnnotationView(annotation: annotation, reuseIdentifier: identifier)
        view.annotation = annotation

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
