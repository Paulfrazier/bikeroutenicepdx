import CoreLocation

/// Dedicated `CLLocationManager` for turn-by-turn navigation. Independent of the
/// planner's `MKUserLocation` blue-dot path in `MapCoordinator` — this one is
/// tuned for live riding (best-for-navigation accuracy, continuous heading, and
/// background updates so guidance keeps running with the screen locked).
///
/// Delegate callbacks arrive on the main run loop (the manager is created on
/// main), and we still hop to the main actor before invoking the handlers so the
/// `@MainActor` `NavigationSession` is always touched safely.
final class NavigationLocationProvider: NSObject, CLLocationManagerDelegate {
    private let manager = CLLocationManager()

    /// Invoked on the main actor for each new GPS fix while navigating.
    var onLocation: (@MainActor (CLLocation) -> Void)?
    /// Invoked on the main actor for each compass heading update (fallback for
    /// camera orientation when the rider is stopped and GPS course is invalid).
    var onHeading: (@MainActor (CLLocationDirection) -> Void)?

    override init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyBestForNavigation
        manager.activityType = .otherNavigation
        manager.distanceFilter = 5 // meters
        manager.headingFilter = 3 // degrees
        manager.pausesLocationUpdatesAutomatically = false
    }

    /// Begin continuous updates. Requests "Always" so guidance survives the app
    /// going to the background mid-ride; falls back gracefully to When-In-Use.
    func start() {
        switch manager.authorizationStatus {
        case .notDetermined:
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            // Ask to upgrade so locked-screen / backgrounded guidance works.
            manager.requestAlwaysAuthorization()
        default:
            break
        }
        // Only legal to set once we actually hold an authorization that allows it;
        // harmless to set eagerly — the system ignores it until granted.
        manager.allowsBackgroundLocationUpdates = true
        manager.startUpdatingLocation()
        manager.startUpdatingHeading()
    }

    func stop() {
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
        manager.allowsBackgroundLocationUpdates = false
    }

    // MARK: - CLLocationManagerDelegate

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let loc = locations.last else { return }
        let cb = onLocation
        Task { @MainActor in cb?(loc) }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateHeading newHeading: CLHeading) {
        guard newHeading.headingAccuracy >= 0 else { return }
        let heading = newHeading.trueHeading >= 0 ? newHeading.trueHeading : newHeading.magneticHeading
        let cb = onHeading
        Task { @MainActor in cb?(heading) }
    }

    func locationManager(_ manager: CLLocationManager, didChangeAuthorization status: CLAuthorizationStatus) {
        if status == .authorizedWhenInUse || status == .authorizedAlways {
            manager.allowsBackgroundLocationUpdates = (status == .authorizedAlways)
            manager.startUpdatingLocation()
            manager.startUpdatingHeading()
        }
    }
}
