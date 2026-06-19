import CoreLocation

/// Sends a drawn finger-trace to the server's /match endpoint and decodes the
/// snapped route. Start/end pins are passed as anchors so the snapped line
/// begins and ends at the user's pins.
struct MatchService {
    func snap(
        trace: [CLLocationCoordinate2D],
        start: CLLocationCoordinate2D?,
        end: CLLocationCoordinate2D?
    ) async throws -> SnappedRoute {
        let body = MatchRequest(
            trace: trace.map { [$0.longitude, $0.latitude] },
            start: start.map { [$0.longitude, $0.latitude] },
            end: end.map { [$0.longitude, $0.latitude] }
        )
        let response = try await APIClient.post(path: "match", body: body, as: MatchResponse.self)
        let coords = response.geometry.coordinates.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count == 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
        }
        return SnappedRoute(coordinates: coords, distanceMeters: response.distance_m)
    }
}
