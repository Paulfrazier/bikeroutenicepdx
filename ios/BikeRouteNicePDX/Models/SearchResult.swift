import Foundation

/// Mirrors the server's GeocodingResult ({ name, context?, lng, lat, type }).
/// Codable (not just Decodable) so recents can be persisted to UserDefaults.
struct SearchResult: Codable, Identifiable, Equatable {
    let name: String
    /// Secondary line (street / neighborhood / city) for two-line display. Optional.
    let context: String?
    let lng: Double
    let lat: Double
    let type: String

    var id: String { "\(lat),\(lng),\(name)" }
}
