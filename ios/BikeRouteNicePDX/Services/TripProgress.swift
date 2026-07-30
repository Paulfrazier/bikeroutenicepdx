import CoreLocation
import Foundation

/// A resumable multi-stop trip, flattened to primitives.
///
/// Deliberately NOT assembled from `Via` / `Waypoint` / `CLLocationCoordinate2D`:
/// none of those are `Codable`, and conforming `Waypoint` would hit the
/// `let id = UUID()` decode trap. A flat DTO also means the planner's models can
/// change shape without silently invalidating everyone's saved trip.
///
/// The `end` place is not optional on purpose — without the final destination
/// the last leg of the trip cannot be reconstructed after a relaunch.
struct TripProgress: Codable, Equatable {
    /// One point on the trip. `label` is the display name, when it has one.
    struct Place: Codable, Equatable {
        var lat: Double
        var lon: Double
        var label: String?

        var coordinate: CLLocationCoordinate2D {
            CLLocationCoordinate2D(latitude: lat, longitude: lon)
        }

        init(lat: Double, lon: Double, label: String?) {
            self.lat = lat
            self.lon = lon
            self.label = label
        }

        init(_ coordinate: CLLocationCoordinate2D, label: String?) {
            self.init(lat: coordinate.latitude, lon: coordinate.longitude, label: label)
        }
    }

    /// Bumped whenever the shape changes, so a record written by an older build
    /// is dropped rather than half-decoded into a confusing partial trip.
    static let currentVersion = 1

    var version: Int
    /// Intermediate stops, in visiting order.
    var stops: [Place]
    /// The trip's final destination.
    var end: Place
    /// Leg being navigated when this was written. Leg *i* ends at `stops[i]`;
    /// the last leg ends at `end`.
    var legIndex: Int
    /// When the ride began, epoch **milliseconds** — also the staleness clock.
    /// Epoch ms rather than a `Date` so the encoded shape matches web's exactly
    /// (Swift's default `Date` strategy would write a 2001-reference Double);
    /// same choice `FavoritePlace.createdAt` makes.
    var startedAt: Double

    init(stops: [Place], end: Place, legIndex: Int, startedAt: Date) {
        self.version = Self.currentVersion
        self.stops = stops
        self.end = end
        self.legIndex = legIndex
        self.startedAt = startedAt.timeIntervalSince1970 * 1000
    }

    /// Name of the destination this trip is working toward right now — the
    /// "Resume trip to X" label.
    var currentLegLabel: String? {
        legIndex < stops.count ? stops[legIndex].label : end.label
    }
}

/// Device-local resume record for an in-progress multi-stop trip.
///
/// Modelled on `Favorites`: an enum of statics over `UserDefaults`, encoding the
/// whole object each time. Mirrors web `web/src/tripProgress.ts` — same storage
/// key, same JSON shape, same staleness cutoff.
///
/// Note the GPS trace is NOT persisted. An app kill mid-trip resumes the
/// *navigation* but loses the ride recording; persisting the trace is a much
/// larger change and deliberately out of scope.
enum TripProgressStore {
    /// Shared storage key — identical to the web `STORAGE_KEY`.
    static let storageKey = "bikenice.tripProgress"

    /// A trip older than this is not offered for resume — yesterday's errand
    /// should never greet you on launch.
    static let staleAfter: TimeInterval = 6 * 60 * 60

    static func save(_ progress: TripProgress) {
        guard let data = try? JSONEncoder().encode(progress) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    /// The saved trip, or nil when there isn't one, it came from an older
    /// schema, or it has gone stale.
    static func load(now: Date = Date()) -> TripProgress? {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let progress = try? JSONDecoder().decode(TripProgress.self, from: data),
              progress.version == TripProgress.currentVersion,
              now.timeIntervalSince1970 - progress.startedAt / 1000 < staleAfter
        else { return nil }
        return progress
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: storageKey)
    }
}
