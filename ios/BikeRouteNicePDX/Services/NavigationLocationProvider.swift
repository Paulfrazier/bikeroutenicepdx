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
    /// True only between `start()` and `stop()`. The authorization callback also
    /// fires when the manager is created (app launch) and on any Settings change,
    /// so it must not start GPS unless a ride is actually in progress.
    private var active = false

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
        // Let iOS pause GPS once the rider has been stationary for a long while
        // (a ride left running in a pocket would otherwise drain the battery at
        // best-for-navigation precision all day). `.otherNavigation` keeps the
        // heuristic conservative, so red lights don't trip it; a pause is
        // undone by `resumeIfPaused()` when the app returns to the foreground.
        manager.pausesLocationUpdatesAutomatically = true
    }

    /// Begin continuous updates. Requests "Always" so guidance survives the app
    /// going to the background mid-ride; falls back gracefully to When-In-Use.
    func start() {
        active = true
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
        active = false
        manager.stopUpdatingLocation()
        manager.stopUpdatingHeading()
        manager.allowsBackgroundLocationUpdates = false
        setCruise(false)
    }

    /// Re-arm updates after an automatic pause. iOS never resumes paused updates
    /// by itself, so the app calls this on returning to the foreground. No-op
    /// unless a ride is in progress.
    func resumeIfPaused() {
        guard active else { return }
        manager.startUpdatingLocation()
        manager.startUpdatingHeading()
    }

    private var cruising = false

    /// Battery saver: on long on-route straights the session relaxes precision
    /// (fewer radio wakeups), restoring best-for-navigation as a maneuver
    /// approaches. Guarded so repeated same-state calls don't touch the manager.
    func setCruise(_ on: Bool) {
        guard on != cruising else { return }
        cruising = on
        manager.desiredAccuracy = on ? kCLLocationAccuracyNearestTenMeters : kCLLocationAccuracyBestForNavigation
        manager.distanceFilter = on ? 15 : 5
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
        guard active else { return }
        if status == .authorizedWhenInUse || status == .authorizedAlways {
            manager.allowsBackgroundLocationUpdates = (status == .authorizedAlways)
            manager.startUpdatingLocation()
            manager.startUpdatingHeading()
        }
    }
}
