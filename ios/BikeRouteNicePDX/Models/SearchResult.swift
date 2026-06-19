import Foundation

/// Mirrors the server's GeocodingResult ({ name, lng, lat, type }).
struct SearchResult: Decodable, Identifiable, Equatable {
    let name: String
    let lng: Double
    let lat: Double
    let type: String

    var id: String { "\(lat),\(lng),\(name)" }
}
