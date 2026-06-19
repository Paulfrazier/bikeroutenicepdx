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

                List(store.searchResults) { result in
                    Button {
                        assign(result)
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(result.name)
                                .font(.body)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(result.type)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                .listStyle(.plain)
                .overlay {
                    if store.searchResults.isEmpty {
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

    private func assign(_ result: SearchResult) {
        let coordinate = CLLocationCoordinate2D(latitude: result.lat, longitude: result.lng)
        store.setPin(coordinate, kind: target, label: result.name)
        dismiss()
    }

    private func debounceSearch(_ text: String) {
        searchTask?.cancel()
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            store.searchResults = []
            return
        }
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000) // 300ms debounce
            if Task.isCancelled { return }
            await store.runSearch(trimmed)
        }
    }
}
