import CoreLocation

/// Sends a drawn finger-trace to the server's /match endpoint and decodes the
/// snapped route. Start/end pins are passed as anchors so the snapped line
/// begins and ends at the user's pins.
struct MatchService {
    func snap(
        trace: [CLLocationCoordinate2D],
        start: CLLocationCoordinate2D?,
        end: CLLocationCoordinate2D?,
        follow: Bool = false
    ) async throws -> SnappedRoute {
        let body = MatchRequest(
            trace: trace.map { [$0.longitude, $0.latitude] },
            start: start.map { [$0.longitude, $0.latitude] },
            end: end.map { [$0.longitude, $0.latitude] },
            follow: follow ? true : nil
        )
        let response = try await APIClient.post(path: "match", body: body, as: MatchResponse.self)
        let coords = response.geometry.coordinates.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count == 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
        }
        return SnappedRoute(coordinates: coords, distanceMeters: response.distance_m)
    }
}

/// Routes start → [vias] → end via the server's /route endpoint, with the via
/// points passed as ordered pass-through waypoints. Powers drag-to-reshape:
/// each dragged point becomes a via and the whole route is recomputed cleanly
/// along real roads (no map-matching of a hand-drawn shape). Decodes into the
/// shared MatchResponse — /route returns a superset, extra keys are ignored.
struct RouteService {
    func route(
        from: CLLocationCoordinate2D,
        to: CLLocationCoordinate2D,
        vias: [CLLocationCoordinate2D],
        preference: String? = nil
    ) async throws -> SnappedRoute {
        let body = RouteRequest(
            from: [from.longitude, from.latitude],
            to: [to.longitude, to.latitude],
            via: vias.map { [$0.longitude, $0.latitude] },
            preference: preference
        )
        let response = try await APIClient.post(path: "route", body: body, as: RouteResponse.self)
        let coords = response.geometry.coordinates.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count == 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
        }
        var route = SnappedRoute(coordinates: coords, distanceMeters: response.distance_m)
        route.steps = response.steps
        return route
    }
}

/// The resolved "route through a section" preview: the ordered pass-through
/// points to inject (as a grouped block of precise vias) plus the full street
/// geometry for the teal highlight line shown while picking the section.
struct CorridorPreview: Equatable {
    var points: [CLLocationCoordinate2D]
    var geometry: [CLLocationCoordinate2D]
}

/// Resolves the literal street between two tapped points into an ordered chain
/// of pass-through points via the server's /corridor endpoint. The chain is
/// injected as a grouped block of `precise` vias so the route is forced through
/// that street section.
struct CorridorService {
    func corridor(
        a: CLLocationCoordinate2D,
        b: CLLocationCoordinate2D
    ) async throws -> CorridorPreview {
        let body = CorridorRequest(
            a: [a.longitude, a.latitude],
            b: [b.longitude, b.latitude]
        )
        let response = try await APIClient.post(path: "corridor", body: body, as: CorridorResponse.self)
        func toCoords(_ pairs: [[Double]]) -> [CLLocationCoordinate2D] {
            pairs.compactMap { pair -> CLLocationCoordinate2D? in
                guard pair.count == 2 else { return nil }
                return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
            }
        }
        return CorridorPreview(
            points: toCoords(response.points),
            geometry: toCoords(response.geometry.coordinates)
        )
    }
}
