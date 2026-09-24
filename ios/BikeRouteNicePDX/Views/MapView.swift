import SwiftUI
import MapKit

/// SwiftUI wrapper around MKMapView. Renders the bundled greenway overlay,
/// the start/end pins, the live finger-draft, and the snapped route.
struct MapView: UIViewRepresentable {
    @Environment(RouteStore.self) private var store
    @Environment(NavigationSession.self) private var nav

    func makeCoordinator() -> MapCoordinator {
        MapCoordinator(store: store)
    }

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.showsUserLocation = true
        map.pointOfInterestFilter = .excludingAll

        // Ask for location permission so the blue user-location dot appears.
        // Setting showsUserLocation alone does NOT trigger the prompt.
        context.coordinator.requestLocationPermission()

        // Center on Portland — still where most rides start — but opened wide
        // enough to show the metro network (Beaverton, Milwaukie, Gresham), which
        // the overlay now covers. Mirrors the web map's default (Map.tsx).
        let center = CLLocationCoordinate2D(latitude: 45.52, longitude: -122.67)
        map.region = MKCoordinateRegion(
            center: center,
            span: MKCoordinateSpan(latitudeDelta: 0.18, longitudeDelta: 0.18)
        )

        // Bike network overlay (one overlay per facility class, better facilities
        // on top) plus the built-but-unpublished "supplement" lanes, which render
        // identically and are tappable for the "learn more" panel. The 8.7 MB
        // parse runs off the main thread so the map is interactive at launch.
        let coordinator = context.coordinator
        Task { @MainActor [weak map] in
            let parsed = await Task.detached(priority: .userInitiated) {
                BikeNetworkLoader.parse()
            }.value
            guard let map else { return }
            let built = BikeNetworkLoader.overlays(from: parsed)
            // Inserted at the BOTTOM of .aboveRoads: anything already on that
            // level (the teal connector fixes) was meant to paint over the
            // network, and may have been added while the parse ran.
            for (i, overlay) in (built.network + built.supplement).enumerated() {
                map.insertOverlay(overlay, at: i, level: .aboveRoads)
            }
            coordinator.supplementHits = built.supplementHits
            // Then, with the map up, pre-build the route classifier's indexes.
            await BikeFriendliness.shared.warmUp()
        }

        // Tap to drop pins.
        let tap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(MapCoordinator.handleTap(_:))
        )
        tap.delegate = context.coordinator
        map.addGestureRecognizer(tap)
        context.coordinator.tapGesture = tap

        // Pan to draw — disabled until draw mode.
        let pan = UIPanGestureRecognizer(
            target: context.coordinator,
            action: #selector(MapCoordinator.handlePan(_:))
        )
        pan.maximumNumberOfTouches = 1
        pan.delegate = context.coordinator
        pan.isEnabled = false
        map.addGestureRecognizer(pan)
        context.coordinator.panGesture = pan

        // Two-finger pan while drawing (drawing-app convention). MKMapView can't
        // do "two-finger-only scroll" natively — isScrollEnabled is all-or-nothing
        // and its internal recognizers are private — so while Draw owns one-finger
        // touches we move the map ourselves from the gesture translation. No
        // require(toFail:) against the draw pan: that would lag every stroke
        // start; the overlap is resolved by an explicit cancel in the handler.
        let twoFingerPan = UIPanGestureRecognizer(
            target: context.coordinator,
            action: #selector(MapCoordinator.handleTwoFingerPan(_:))
        )
        twoFingerPan.minimumNumberOfTouches = 2
        twoFingerPan.maximumNumberOfTouches = 2
        twoFingerPan.delegate = context.coordinator
        twoFingerPan.isEnabled = false
        map.addGestureRecognizer(twoFingerPan)
        context.coordinator.twoFingerPanGesture = twoFingerPan

        // Pan to hand-edit an existing route line — enabled by sync() only when
        // a route exists and we're not drawing. gestureRecognizerShouldBegin
        // gates it so it only grabs the touch when it starts on the line.
        let editPan = UIPanGestureRecognizer(
            target: context.coordinator,
            action: #selector(MapCoordinator.handleEditPan(_:))
        )
        editPan.maximumNumberOfTouches = 1
        editPan.delegate = context.coordinator
        editPan.isEnabled = false
        map.addGestureRecognizer(editPan)
        context.coordinator.editPanGesture = editPan

        // Long-press in edit mode: toggle a pin's precise flag, or drop a precise
        // (non-snapping) anchor on the line to force a crossing.
        let longPress = UILongPressGestureRecognizer(
            target: context.coordinator,
            action: #selector(MapCoordinator.handleLongPress(_:))
        )
        longPress.minimumPressDuration = 0.45
        longPress.delegate = context.coordinator
        map.addGestureRecognizer(longPress)
        context.coordinator.editLongPressGesture = longPress

        // A hold must NOT also fire the tap (which deletes the pin). Make the tap
        // wait for the long-press to fail: a quick tap still deletes (long-press
        // fails on early lift), but a hold toggles precise without deleting.
        tap.require(toFail: longPress)

        context.coordinator.mapView = map
        return map
    }

    func updateUIView(_ uiView: MKMapView, context: Context) {
        context.coordinator.store = store
        context.coordinator.nav = nav
        context.coordinator.sync()
        context.coordinator.syncNav()
    }
}
