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
        let response = try await APIClient.post(path: "route", body: body, as: MatchResponse.self)
        let coords = response.geometry.coordinates.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count == 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
        }
        return SnappedRoute(coordinates: coords, distanceMeters: response.distance_m)
    }
}
