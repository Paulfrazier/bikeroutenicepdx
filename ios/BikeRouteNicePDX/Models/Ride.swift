import CoreLocation
import Foundation

/// A completed navigated ride, persisted to disk for the history view. Coordinates
/// are stored as `[lng, lat]` pairs (CLLocationCoordinate2D isn't Codable).
struct Ride: Identifiable, Codable, Equatable {
    var id: UUID
    var date: Date
    var distanceMeters: Double
    var durationSeconds: Double
    /// Fraction (0–1) of the route on comfortable bike infrastructure.
    var greenwayShare: Double
    /// The recorded GPS trace, `[lng, lat]` pairs.
    var track: [[Double]]

    init(
        id: UUID = UUID(),
        date: Date,
        distanceMeters: Double,
        durationSeconds: Double,
        greenwayShare: Double,
        coordinates: [CLLocationCoordinate2D]
    ) {
        self.id = id
        self.date = date
        self.distanceMeters = distanceMeters
        self.durationSeconds = durationSeconds
        self.greenwayShare = greenwayShare
        self.track = coordinates.map { [$0.longitude, $0.latitude] }
    }

    var coordinates: [CLLocationCoordinate2D] {
        track.compactMap { $0.count == 2 ? CLLocationCoordinate2D(latitude: $0[1], longitude: $0[0]) : nil }
    }

    // MARK: - Display

    var distanceLabel: String {
        let miles = distanceMeters / 1609.344
        return String(format: "%.1f mi", miles)
    }

    var durationLabel: String {
        let min = Int((durationSeconds / 60).rounded())
        if min < 60 { return "\(min) min" }
        return "\(min / 60) h \(min % 60) min"
    }

    var greenwayLabel: String { "\(Int((greenwayShare * 100).rounded()))% on greenways" }

    var averageSpeedMph: Double {
        guard durationSeconds > 0 else { return 0 }
        return (distanceMeters / 1609.344) / (durationSeconds / 3600)
    }

    /// A minimal GPX document for sharing/exporting the trace.
    func gpx() -> String {
        let pts = coordinates.map {
            "    <trkpt lat=\"\($0.latitude)\" lon=\"\($0.longitude)\"></trkpt>"
        }.joined(separator: "\n")
        return """
        <?xml version="1.0" encoding="UTF-8"?>
        <gpx version="1.1" creator="BikeRouteNicePDX" xmlns="http://www.topografix.com/GPX/1/1">
          <trk><name>Ride \(date.formatted(date: .abbreviated, time: .shortened))</name><trkseg>
        \(pts)
          </trkseg></trk>
        </gpx>
        """
    }
}
