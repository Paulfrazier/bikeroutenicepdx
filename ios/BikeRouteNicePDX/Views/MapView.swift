import SwiftUI
import MapKit

/// SwiftUI wrapper around MKMapView. Renders the bundled greenway overlay,
/// the start/end pins, the live finger-draft, and the snapped route.
struct MapView: UIViewRepresentable {
    @Environment(RouteStore.self) private var store

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

        // Center on Portland.
        let center = CLLocationCoordinate2D(latitude: 45.52, longitude: -122.67)
        map.region = MKCoordinateRegion(
            center: center,
            span: MKCoordinateSpan(latitudeDelta: 0.09, longitudeDelta: 0.09)
        )

        // Full Portland bike network overlay — added once, one overlay per
        // facility class (already sorted so better facilities draw on top).
        let network = BikeNetworkLoader.loadOverlays()
        if !network.isEmpty {
            map.addOverlays(network, level: .aboveRoads)
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

        context.coordinator.mapView = map
        return map
    }

    func updateUIView(_ uiView: MKMapView, context: Context) {
        context.coordinator.store = store
        context.coordinator.sync()
    }
}
