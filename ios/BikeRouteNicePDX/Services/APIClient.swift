import Foundation

enum APIError: LocalizedError {
    case http(Int, String)
    case transport(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .http(_, let message): return message
        case .transport(let message): return message
        case .decoding(let message): return message
        }
    }
}

/// Thin wrapper over URLSession for the BikeRouteNicePDX server.
/// Base URL comes from the `APIBaseURL` Info.plist key (default localhost:3000).
enum APIClient {
    static let baseURL: URL = {
        let raw = (Bundle.main.object(forInfoDictionaryKey: "APIBaseURL") as? String)
            ?? "http://localhost:3000"
        return URL(string: raw) ?? URL(string: "http://localhost:3000")!
    }()

    private static let session = URLSession.shared
    private static let decoder = JSONDecoder()

    static func get<T: Decodable>(
        path: String,
        query: [URLQueryItem],
        as type: T.Type
    ) async throws -> T {
        guard var comps = URLComponents(
            url: baseURL.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        ) else {
            throw APIError.transport("Bad URL for \(path)")
        }
        comps.queryItems = query
        guard let url = comps.url else { throw APIError.transport("Bad URL for \(path)") }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        return try await send(req, as: type)
    }

    static func post<B: Encodable, T: Decodable>(
        path: String,
        body: B,
        as type: T.Type
    ) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        do {
            req.httpBody = try JSONEncoder().encode(body)
        } catch {
            throw APIError.transport("Failed to encode request: \(error.localizedDescription)")
        }
        return try await send(req, as: type)
    }

    private static func send<T: Decodable>(_ req: URLRequest, as type: T.Type) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw APIError.transport("No HTTP response")
        }

        guard (200..<300).contains(http.statusCode) else {
            if let body = try? decoder.decode(APIErrorBody.self, from: data) {
                throw APIError.http(http.statusCode, body.error)
            }
            throw APIError.http(http.statusCode, "Server error (\(http.statusCode))")
        }

        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error.localizedDescription)
        }
    }
}
