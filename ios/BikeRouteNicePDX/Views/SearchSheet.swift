import SwiftUI
import CoreLocation

/// Where a picked place goes.
///
/// This is passed IN by whichever trip row the rider tapped — it is deliberately
/// not something `SearchSheet` asks about. Making the rider classify a place
/// ("is this a stop or the finish?") from a segmented control before they'd even
/// seen the search results was the friction this whole flow exists to remove.
///
/// `.stop` appends to the trip's stop list rather than replacing a pin, so it
/// isn't a `WaypointKind` (which models pins).
enum SearchTarget: Hashable, Identifiable {
    case start
    case stop
    /// Repoint an existing stop, keeping its place in the trip order.
    case editStop(UUID)
    case end

    var id: String {
        switch self {
        case .start: return "start"
        case .stop: return "stop"
        case .editStop(let id): return "editStop-\(id.uuidString)"
        case .end: return "end"
        }
    }
}

/// Search for a place and assign it to whichever trip row summoned this sheet.
struct SearchSheet: View {
    @Environment(RouteStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    let target: SearchTarget

    @State private var query = ""
    @State private var searchTask: Task<Void, Never>?
    /// Local mirror of the Favorites store, refreshed on the change notification.
    @State private var favorites: [FavoritePlace] = Favorites.list()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                List {
                    // Saved places sit above everything: matched locally by
                    // nickname, so "Home" is reachable without the geocoder.
                    if !matchingFavorites.isEmpty {
                        Section("Saved") {
                            ForEach(matchingFavorites) { favorite in
                                // The nickname is what the pin label should read.
                                resultRow(renamed(favorite), saved: true)
                            }
                        }
                    }
                    if showingRecents {
                        Section("Recent") {
                            ForEach(dedupedAgainstFavorites(store.recentSearches)) { result in
                                resultRow(result)
                            }
                        }
                    } else {
                        ForEach(dedupedAgainstFavorites(store.searchResults)) { result in
                            resultRow(result)
                        }
                    }
                }
                .listStyle(.plain)
                .overlay {
                    if store.searchResults.isEmpty && !showingRecents
                        && matchingFavorites.isEmpty {
                        ContentUnavailableView(
                            "Search for a place",
                            systemImage: "magnifyingglass",
                            description: Text("Find an address or landmark in the Portland metro to set your \(targetNoun).")
                        )
                    }
                }
            }
            .navigationTitle(navTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Address or place")
            .onChange(of: query) { _, newValue in
                debounceSearch(newValue)
            }
            .onAppear {
                favorites = Favorites.list()
            }
            .onReceive(NotificationCenter.default.publisher(for: .favoritesChanged)) { _ in
                favorites = Favorites.list()
            }
        }
    }

    private var targetNoun: String {
        switch target {
        case .start: return "start"
        case .stop: return "next stop"
        case .editStop: return "stop"
        case .end: return "destination"
        }
    }

    private var navTitle: String {
        switch target {
        case .stop: return "Add a stop"
        case .editStop: return "Change stop"
        default: return "Set \(targetNoun)"
        }
    }

    /// Recents are shown when the user hasn't typed a meaningful query yet.
    private var showingRecents: Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count < RouteStore.minSearchLength
            && store.searchResults.isEmpty
            && !store.recentSearches.isEmpty
    }

    /// Lowercase and strip punctuation so "powells" matches "Powell's".
    /// Mirrors the web `fold()` in SearchBar.tsx.
    private func fold(_ s: String) -> String {
        s.lowercased().filter { $0.isLetter || $0.isNumber }
    }

    /// Favorites matching the current query (all of them when nothing is typed).
    private var matchingFavorites: [FavoritePlace] {
        let q = fold(query)
        guard !q.isEmpty else { return favorites }
        return favorites.filter { fold($0.name).contains(q) || fold($0.place.name).contains(q) }
    }

    /// A favorite as a SearchResult carrying its nickname.
    private func renamed(_ favorite: FavoritePlace) -> SearchResult {
        SearchResult(
            name: favorite.name,
            context: favorite.place.context,
            lng: favorite.place.lng,
            lat: favorite.place.lat,
            type: favorite.place.type
        )
    }

    /// Drop entries already shown in the Saved section (matched by coordinate).
    private func dedupedAgainstFavorites(_ results: [SearchResult]) -> [SearchResult] {
        let keys = Set(matchingFavorites.map { "\($0.place.lng),\($0.place.lat)" })
        return results.filter { !keys.contains("\($0.lng),\($0.lat)") }
    }

    @ViewBuilder
    private func resultRow(_ result: SearchResult, saved: Bool = false) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Button {
                assign(result, isFavorite: saved)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text((saved ? "saved" : result.type).uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 4))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(result.name)
                            .font(.body)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        if let context = result.context, !context.isEmpty {
                            Text(context)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }

            // A saved place can also surface as a plain result (the query didn't
            // match its nickname), so the star reflects real saved state — never
            // just which section the row landed in. Mirrors the web star.
            let isSaved = saved || Favorites.isFavorite(result)
            Button {
                Favorites.toggle(result)
            } label: {
                Image(systemName: isSaved ? "star.fill" : "star")
                    .foregroundStyle(isSaved ? Color.orange : Color.secondary)
            }
            .accessibilityLabel(isSaved ? "Remove \(result.name) from saved" : "Save \(result.name)")
        }
        // Both buttons in one row need borderless, or a tap anywhere fires both.
        .buttonStyle(.borderless)
    }

    private func assign(_ result: SearchResult, isFavorite: Bool = false) {
        switch target {
        case .stop:
            Task { await store.addStop(result) }
        case .editStop(let id):
            Task { await store.updateStop(id: id, to: result) }
        case .start, .end:
            let coordinate = CLLocationCoordinate2D(latitude: result.lat, longitude: result.lng)
            store.setPin(coordinate, kind: target == .start ? .start : .end, label: result.name)
        }
        // Favorites are already durable — recording them as "recent" would only
        // evict genuinely recent picks from the 5-slot list. Mirrors the web.
        if !isFavorite { store.addRecent(result) }
        dismiss()
    }

    private func debounceSearch(_ text: String) {
        searchTask?.cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= RouteStore.minSearchLength else {
            store.searchResults = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000) // 250ms debounce
            if Task.isCancelled { return }
            await store.runSearch(trimmed)
        }
    }
}
