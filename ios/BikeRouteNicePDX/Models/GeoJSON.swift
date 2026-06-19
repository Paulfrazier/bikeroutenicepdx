import Foundation

/// Request body for POST /match. Coordinates are [lng, lat] to match the server.
struct MatchRequest: Encodable {
    let trace: [[Double]]
    let start: [Double]?
    let end: [Double]?
    /// True for hand-edit re-snaps: the server then hugs the drawn path onto the
    /// nearest road (incl. non-bike streets) instead of favoring greenways.
    let follow: Bool?
}

/// Response from POST /match (and /route) — a GeoJSON LineString + totals.
struct MatchResponse: Decodable {
    struct Geometry: Decodable {
        let type: String
        let coordinates: [[Double]] // [lng, lat]
    }
    let geometry: Geometry
    let distance_m: Double
    let duration_s: Double
}

/// The server's error envelope: { error, code }.
struct APIErrorBody: Decodable {
    let error: String
    let code: String?
}
