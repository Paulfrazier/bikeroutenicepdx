import CoreLocation
import Foundation

/// A user's personal network "connector" — a short hand-drawn link that fills a
/// gap the routing data misses (a cycletrack OSM mislabels, a median/crosswalk
/// connection, a cut-through). Unlike the ephemeral per-route `ManualSegment`, a
/// connector is SAVED globally on this device and feeds the route machinery
/// everywhere: rendered on the map, classified as a `path` facility, snapped to
/// on drag, and auto-spliced into any route that passes near both of its ends.
///
/// Personal connectors live here (UserDefaults). Validated COMMUNITY connectors
/// ship separately as the bundled `community-fixes.geojson` (see
/// `CommunityConnectors` + BikeFriendliness) — both sources feed one connector
/// index, but only personal ones are mutable here.
///
/// MUST stay in lockstep with web `web/src/connectors.ts` — same shape, same
/// storage key, same JSON `{id, coords:[[lng,lat]], name?, createdAt}`.
struct Connector: Identifiable {
    let id: String
    /// Polyline of the drawn link (verbatim, like a ManualSegment).
    var coords: [CLLocationCoordinate2D]
    /// Optional user label (e.g. "SE 16th cycletrack @ Hawthorne").
    var name: String?
    /// Epoch ms when created.
    let createdAt: Double
}

enum Connectors {
    /// Shared storage key — identical to the web `STORAGE_KEY`.
    static let storageKey = "bikenice.connectors"

    /// On-disk shape: coords as `[[lng, lat]]` so the JSON matches web verbatim.
    private struct Stored: Codable {
        let id: String
        let coords: [[Double]]
        let name: String?
        let createdAt: Double
    }

    // A local, best-effort uniqueness counter (paired with the ms timestamp in
    // nextId). Connector mutations happen on the main actor in practice; the
    // counter only needs to disambiguate two adds within the same millisecond, so
    // unsynchronized access is acceptable. Mirrors web's plain `idCounter`.
    nonisolated(unsafe) private static var idCounter = 0

    /// Time + counter; unique within a device, stable enough for a local store.
    /// Mirrors the web `conn-${Date.now().toString(36)}-${counter.toString(36)}`.
    private static func nextId() -> String {
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let id = "conn-\(String(ms, radix: 36))-\(String(idCounter, radix: 36))"
        idCounter += 1
        return id
    }

    // MARK: - Persistence

    /// Load + validate stored connectors (drop anything with <2 points), keeping
    /// the raw on-disk shape. Insertion order preserved.
    private static func loadStored() -> [Stored] {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let arr = try? JSONDecoder().decode([Stored].self, from: data)
        else { return [] }
        return arr.filter { $0.coords.count >= 2 }
    }

    /// Persist + broadcast the change so the route reclassifies and re-splices.
    private static func persist(_ stored: [Stored]) {
        if let data = try? JSONEncoder().encode(stored) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
        NotificationCenter.default.post(name: .connectorsChanged, object: nil)
    }

    private static func toConnector(_ s: Stored) -> Connector {
        let coords = s.coords.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
        }
        return Connector(id: s.id, coords: coords, name: s.name, createdAt: s.createdAt)
    }

    private static func toStored(_ c: Connector) -> Stored {
        Stored(
            id: c.id,
            coords: c.coords.map { [$0.longitude, $0.latitude] },
            name: c.name,
            createdAt: c.createdAt
        )
    }

    // MARK: - Public API (mirrors connectors.ts)

    /// All personal connectors (newest first).
    static func list() -> [Connector] {
        loadStored()
            .sorted { $0.createdAt > $1.createdAt }
            .map(toConnector)
    }

    /// True if the user has any personal connectors (drives the "personalized" marker).
    static var hasConnectors: Bool { !loadStored().isEmpty }

    /// Add a drawn connector; returns it. Needs ≥2 points.
    @discardableResult
    static func add(coords: [CLLocationCoordinate2D], name: String? = nil) -> Connector? {
        guard coords.count >= 2 else { return nil }
        let connector = Connector(
            id: nextId(),
            coords: coords,
            name: name,
            createdAt: Date().timeIntervalSince1970 * 1000
        )
        var stored = loadStored()
        stored.append(toStored(connector))
        persist(stored)
        return connector
    }

    /// Rename a connector by id.
    static func rename(_ id: String, _ name: String) {
        var stored = loadStored()
        guard let i = stored.firstIndex(where: { $0.id == id }) else { return }
        let old = stored[i]
        stored[i] = Stored(id: old.id, coords: old.coords, name: name, createdAt: old.createdAt)
        persist(stored)
    }

    /// Remove a connector by id.
    static func remove(_ id: String) {
        let stored = loadStored()
        guard stored.contains(where: { $0.id == id }) else { return }
        persist(stored.filter { $0.id != id })
    }

    /// Replace a connector's coords (e.g. after reshaping a vertex). Needs ≥2 points.
    static func updateCoords(_ id: String, _ coords: [CLLocationCoordinate2D]) {
        guard coords.count >= 2 else { return }
        var stored = loadStored()
        guard let i = stored.firstIndex(where: { $0.id == id }) else { return }
        let old = stored[i]
        stored[i] = Stored(
            id: old.id,
            coords: coords.map { [$0.longitude, $0.latitude] },
            name: old.name,
            createdAt: old.createdAt
        )
        persist(stored)
    }
}

/// Parses the bundled `community-fixes.geojson` (validated, shipped fixes) into
/// polylines. Graceful: a missing / empty / degenerate file → `[]`, exactly like
/// the optional hazard overlays in BikeFriendliness. Shared by the connector
/// index (BikeFriendliness) and the render layer (MapCoordinator) so both read
/// the same community geometry.
enum CommunityConnectors {
    static func lines() -> [[CLLocationCoordinate2D]] {
        guard
            let url = Bundle.main.url(forResource: "community-fixes", withExtension: "geojson"),
            let data = try? Data(contentsOf: url),
            // JSONSerialization (not MKGeoJSONDecoder): one bad feature must not
            // nuke the whole collection.
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let features = root["features"] as? [[String: Any]]
        else {
            return []
        }
        var out: [[CLLocationCoordinate2D]] = []
        for feature in features {
            guard
                let geometry = feature["geometry"] as? [String: Any],
                let type = geometry["type"] as? String
            else { continue }
            switch type {
            case "LineString":
                if let line = geometry["coordinates"] as? [[Double]] { append(line, to: &out) }
            case "MultiLineString":
                if let lines = geometry["coordinates"] as? [[[Double]]] {
                    for line in lines { append(line, to: &out) }
                }
            default:
                continue
            }
        }
        return out
    }

    private static func append(_ line: [[Double]], to out: inout [[CLLocationCoordinate2D]]) {
        let coords = line.compactMap { pair -> CLLocationCoordinate2D? in
            guard pair.count >= 2 else { return nil }
            return CLLocationCoordinate2D(latitude: pair[1], longitude: pair[0])
        }
        if coords.count >= 2 { out.append(coords) }
    }
}

extension Notification.Name {
    /// Posted whenever the user's personal connectors change (re-classify +
    /// re-splice the route). Mirrors `.streetRatingsChanged`.
    static let connectorsChanged = Notification.Name("bikenice.connectorsChanged")
}
