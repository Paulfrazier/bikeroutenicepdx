import Foundation

/// Geocoding for the start/end pins, backed by the server's /search endpoint.
struct SearchService {
    func geocode(_ query: String, limit: Int = 5) async throws -> [SearchResult] {
        try await APIClient.get(
            path: "search",
            query: [
                URLQueryItem(name: "q", value: query),
                URLQueryItem(name: "limit", value: String(limit)),
            ],
            as: [SearchResult].self
        )
    }
}
