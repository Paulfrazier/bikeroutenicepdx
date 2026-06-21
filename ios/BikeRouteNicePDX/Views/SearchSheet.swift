import SwiftUI
import CoreLocation

/// Search for a place and assign it to the start or end pin.
struct SearchSheet: View {
    @Environment(RouteStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    @State private var query = ""
    @State private var target: WaypointKind = .start
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Pin", selection: $target) {
                    Text("Start").tag(WaypointKind.start)
                    Text("Destination").tag(WaypointKind.end)
                }
                .pickerStyle(.segmented)
                .padding(16)

                List {
                    if showingRecents {
                        Section("Recent") {
                            ForEach(store.recentSearches) { result in
                                resultRow(result)
                            }
                        }
                    } else {
                        ForEach(store.searchResults) { result in
                            resultRow(result)
                        }
                    }
                }
                .listStyle(.plain)
                .overlay {
                    if store.searchResults.isEmpty && !showingRecents {
                        ContentUnavailableView(
                            "Search for a place",
                            systemImage: "magnifyingglass",
                            description: Text("Find an address or landmark in Portland to set your \(target == .start ? "start" : "destination").")
                        )
                    }
                }
            }
            .navigationTitle("Set \(target == .start ? "start" : "destination")")
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
                // Default to whichever pin is still unset.
                target = store.start == nil ? .start : .end
            }
        }
    }

    /// Recents are shown when the user hasn't typed a meaningful query yet.
    private var showingRecents: Bool {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count < RouteStore.minSearchLength
            && store.searchResults.isEmpty
            && !store.recentSearches.isEmpty
    }

    @ViewBuilder
    private func resultRow(_ result: SearchResult) -> some View {
        Button {
            assign(result)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(result.type.uppercased())
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
            }
        }
    }

    private func assign(_ result: SearchResult) {
        let coordinate = CLLocationCoordinate2D(latitude: result.lat, longitude: result.lng)
        store.setPin(coordinate, kind: target, label: result.name)
        store.addRecent(result)
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
