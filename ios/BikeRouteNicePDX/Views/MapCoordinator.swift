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

    private var startAnnotation: MKPointAnnotation?
    private var endAnnotation: MKPointAnnotation?
    private var routeOverlay: RoutePolyline?

    // Live finger-draw state (kept here, not in the store, so map moves don't
    // thrash SwiftUI's updateUIView while the finger is down).
    private var draftOverlay: DraftPolyline?
    private var draftCoords: [CLLocationCoordinate2D] = []
    private var lastScreenPoint: CGPoint?

    private static let minScreenStep: CGFloat = 8 // points between captured samples

    init(store: RouteStore) {
        self.store = store
    }

    // MARK: - Declarative reconcile (called from updateUIView)

    func sync() {
        guard let map = mapView else { return }

        // Lock map interaction while drawing so our pan gesture owns the touch.
        let drawing = store.isDrawMode
        map.isScrollEnabled = !drawing
        map.isZoomEnabled = !drawing
        map.isRotateEnabled = !drawing
        map.isPitchEnabled = !drawing
        panGesture?.isEnabled = drawing
        tapGesture?.isEnabled = !drawing

        syncAnnotation(&startAnnotation, waypoint: store.start, title: "Start", map: map)
        syncAnnotation(&endAnnotation, waypoint: store.end, title: "End", map: map)

        if let snapped = store.snapped {
            let needsUpdate =
                routeOverlay == nil || routeOverlay?.pointCount != snapped.coordinates.count
            if needsUpdate {
                if let existing = routeOverlay { map.removeOverlay(existing) }
                let overlay = RoutePolyline(
                    coordinates: snapped.coordinates,
                    count: snapped.coordinates.count
                )
                routeOverlay = overlay
                map.addOverlay(overlay, level: .aboveLabels)
                map.setVisibleMapRect(
                    overlay.boundingMapRect,
                    edgePadding: UIEdgeInsets(top: 90, left: 40, bottom: 240, right: 40),
                    animated: true
                )
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
}
