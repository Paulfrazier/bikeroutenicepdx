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

/// Request body for POST /route. Coordinates are [lng, lat]. `via` carries the
/// ordered drag-to-reshape pass-through waypoints.
struct RouteRequest: Encodable {
    let from: [Double]
    let to: [Double]
    let via: [[Double]]
    /// "comfort" | "balanced" | "fast" — maps to the server's use_roads. Omitted
    /// (nil) lets the server default to comfort.
    let preference: String?
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

/// One turn-by-turn step from POST /route.
struct RouteStep: Decodable, Equatable {
    let instruction: String
    let distance_m: Double
    let street_name: String?
    let maneuver_type: String
    let bicycle_network_class: String?
    let location: [Double] // [lng, lat]
}

/// Response from POST /route — geometry + totals + turn-by-turn steps.
struct RouteResponse: Decodable {
    struct Geometry: Decodable {
        let type: String
        let coordinates: [[Double]] // [lng, lat]
    }
    let geometry: Geometry
    let distance_m: Double
    let duration_s: Double
    let steps: [RouteStep]
}

/// The server's error envelope: { error, code }.
struct APIErrorBody: Decodable {
    let error: String
    let code: String?
}
