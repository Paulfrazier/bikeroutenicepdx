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
    /// "prod" | "selfbuild" — routing engine override. Omitted (nil) lets the
    /// server default to "prod" (backward-compatible).
    let engine: String?
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

/// Request body for POST /corridor. Tap point A then point B on a street; the
/// server resolves the literal street between them. Coordinates are [lng, lat].
struct CorridorRequest: Encodable {
    let a: [Double]
    let b: [Double]
}

/// Response from POST /corridor — the ordered pass-through points sampled along
/// the resolved street (≈ every 110m, ≤40, includes first+last) to inject as a
/// grouped block of vias, plus the full street geometry for the highlight preview.
struct CorridorResponse: Decodable {
    struct Geometry: Decodable {
        let type: String
        let coordinates: [[Double]] // [lng, lat]
    }
    let points: [[Double]] // [lng, lat], ordered
    let geometry: Geometry
}

/// The server's error envelope: { error, code }.
struct APIErrorBody: Decodable {
    let error: String
    let code: String?
}

/// Request body for POST /fix-submit — a drawn connector filed for community
/// review. Coordinates are [lng, lat] to match the server (and web
/// `FixSubmitRequest`). `note`/`contact` are optional free text.
struct FixSubmitRequest: Encodable {
    let coords: [[Double]]
    let note: String?
    let contact: String?
}

/// Response from POST /fix-submit. `url` is the created issue's html_url (when
/// the server is configured for it). Mirrors web `FixSubmitResponse`.
struct FixSubmitResponse: Decodable {
    let status: String
    let url: String?
}
