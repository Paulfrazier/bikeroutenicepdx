import Foundation

/// A place the user starred so they never have to re-type it: home, the kid's
/// school, the grocery store. Wraps a `SearchResult` verbatim (the same object
/// recents persist) plus a user-editable nickname and a manual sort position, so
/// "Home" can sit at the top regardless of when it was added.
///
/// Device-local like street ratings and connectors — nothing is sent to the
/// server. Favorites feed the search sheet (above Recent) and the manage sheet.
///
/// MUST stay in lockstep with web `web/src/favorites.ts` — same shape, same
/// storage key, same JSON `{id, name, place:{name,context?,lng,lat,type},
/// createdAt, order}`.
struct FavoritePlace: Identifiable, Codable, Equatable {
    let id: String
    /// User nickname. Defaults to the geocoded `place.name` when starred.
    var name: String
    /// The geocoded place, stored verbatim so it can be used as an endpoint as-is.
    var place: SearchResult
    /// Epoch ms when starred.
    let createdAt: Double
    /// Manual sort position, normalized to 0..n-1 on every mutation.
    var order: Int
}

enum Favorites {
    /// Shared storage key — identical to the web `STORAGE_KEY`.
    static let storageKey = "bikenice.favorites"

    /// Plenty for a personal list; guards a runaway paste from filling storage.
    static let maxFavorites = 50

    // Best-effort uniqueness counter paired with the ms timestamp in nextId.
    // Mutations happen on the main actor in practice; the counter only needs to
    // disambiguate two adds within the same millisecond. Mirrors web's idCounter.
    nonisolated(unsafe) private static var idCounter = 0

    /// Mirrors the web `fav-${Date.now().toString(36)}-${counter.toString(36)}`.
    private static func nextId() -> String {
        let ms = Int(Date().timeIntervalSince1970 * 1000)
        let id = "fav-\(String(ms, radix: 36))-\(String(idCounter, radix: 36))"
        idCounter += 1
        return id
    }

    /// Identity of a place by position — the same dedupe key recents use.
    private static func coordKey(_ place: SearchResult) -> String {
        "\(place.lng),\(place.lat)"
    }

    // MARK: - Persistence

    private static func load() -> [FavoritePlace] {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let arr = try? JSONDecoder().decode([FavoritePlace].self, from: data)
        else { return [] }
        return normalize(arr)
    }

    /// Sort by `order` and rewrite it to a dense 0..n-1 range.
    private static func normalize(_ list: [FavoritePlace]) -> [FavoritePlace] {
        list.sorted { ($0.order, $0.createdAt) < ($1.order, $1.createdAt) }
            .enumerated()
            .map { i, f in
                var copy = f
                copy.order = i
                return copy
            }
    }

    private static func persist(_ list: [FavoritePlace]) {
        let normalized = normalize(list)
        if let data = try? JSONEncoder().encode(normalized) {
            UserDefaults.standard.set(data, forKey: storageKey)
        }
        NotificationCenter.default.post(name: .favoritesChanged, object: nil)
    }

    // MARK: - Public API (mirrors favorites.ts)

    /// All favorites in the user's manual order.
    static func list() -> [FavoritePlace] { load() }

    static var hasFavorites: Bool { !load().isEmpty }

    /// The favorite saved at this place, if any.
    static func find(_ place: SearchResult) -> FavoritePlace? {
        let key = coordKey(place)
        return load().first { coordKey($0.place) == key }
    }

    static func isFavorite(_ place: SearchResult) -> Bool { find(place) != nil }

    /// Star a place. Appends to the end. No-op (returns the existing entry) if
    /// this exact coordinate is already saved, so a double-tap can't duplicate.
    @discardableResult
    static func add(_ place: SearchResult, name: String? = nil) -> FavoritePlace? {
        if let existing = find(place) { return existing }
        var list = load()
        guard list.count < maxFavorites else { return nil }
        let trimmed = (name ?? place.name).trimmingCharacters(in: .whitespacesAndNewlines)
        let favorite = FavoritePlace(
            id: nextId(),
            name: trimmed.isEmpty ? place.name : trimmed,
            place: place,
            createdAt: Date().timeIntervalSince1970 * 1000,
            order: list.count
        )
        list.append(favorite)
        persist(list)
        return favorite
    }

    static func rename(_ id: String, _ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var list = load()
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        list[i].name = trimmed
        persist(list)
    }

    static func remove(_ id: String) {
        let list = load()
        guard list.contains(where: { $0.id == id }) else { return }
        persist(list.filter { $0.id != id })
    }

    /// Remove by place — what a star toggle in a result row needs.
    static func remove(at place: SearchResult) {
        if let existing = find(place) { remove(existing.id) }
    }

    /// Star if unsaved, unstar if saved. Returns true when it ends up saved.
    @discardableResult
    static func toggle(_ place: SearchResult) -> Bool {
        if let existing = find(place) {
            remove(existing.id)
            return false
        }
        return add(place) != nil
    }

    /// Reorder from a SwiftUI `.onMove` (which hands back offsets, not ids).
    ///
    /// Implemented by hand rather than via `Array.move(fromOffsets:toOffset:)`:
    /// that method comes from SwiftUI, and this store is pure Foundation (like
    /// `Connectors`). It only compiles here at all because another file in the
    /// module imports SwiftUI — too fragile to rely on. Semantics match SwiftUI's:
    /// the moved items land *before* whatever was at `destination`.
    static func move(fromOffsets source: IndexSet, toOffset destination: Int) {
        var list = load()
        guard !list.isEmpty else { return }
        let moving = source.compactMap { list.indices.contains($0) ? list[$0] : nil }
        guard !moving.isEmpty else { return }
        // Removing earlier items shifts the destination left by that many.
        let removedBefore = source.filter { $0 < destination }.count
        for i in source.sorted(by: >) where list.indices.contains(i) {
            list.remove(at: i)
        }
        let insertAt = min(max(0, destination - removedBefore), list.count)
        list.insert(contentsOf: moving, at: insertAt)
        // Renumber so `normalize` in persist() keeps this exact order.
        for i in list.indices { list[i].order = i }
        persist(list)
    }
}

extension Notification.Name {
    /// Posted whenever the user's saved places change. Mirrors `.connectorsChanged`.
    static let favoritesChanged = Notification.Name("bikenice.favoritesChanged")
}
