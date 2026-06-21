import Foundation
import Observation

/// Persists completed rides as a single JSON file in Documents and exposes them
/// (newest first) to the history view. Small data set — load all, rewrite whole.
@MainActor
@Observable
final class RideStore {
    static let shared = RideStore()

    private(set) var rides: [Ride] = []

    private let url: URL = {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("rides.json")
    }()

    private init() { load() }

    func add(_ ride: Ride) {
        rides.insert(ride, at: 0)
        save()
    }

    func delete(_ ride: Ride) {
        rides.removeAll { $0.id == ride.id }
        save()
    }

    private func load() {
        guard let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder.iso.decode([Ride].self, from: data) else { return }
        rides = decoded.sorted { $0.date > $1.date }
    }

    private func save() {
        guard let data = try? JSONEncoder.iso.encode(rides) else { return }
        try? data.write(to: url, options: .atomic)
    }
}

private extension JSONDecoder {
    static let iso: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .iso8601
        return d
    }()
}

private extension JSONEncoder {
    static let iso: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        return e
    }()
}
