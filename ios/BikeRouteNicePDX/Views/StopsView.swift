import SwiftUI

/// Drag-reorder for the trip's stops. Reorder to change the order they're
/// visited (the route recomputes), or swipe to drop one.
///
/// Stops are added, removed, repointed, and nudged one place at a time from the
/// inline `TripListView` — this sheet exists only for DRAGGING several into a
/// new order, which SwiftUI's `.onMove` can only do inside a `List` with an
/// `EditButton`. It's reached from a stop row's ⋯ menu, never on its own.
struct StopsView: View {
    @Environment(RouteStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.stops.isEmpty {
                    ContentUnavailableView {
                        Label("No stops", systemImage: "mappin.and.ellipse")
                    } description: {
                        Text("Use “Add a stop” under your destination to run errands on the way — the route is split into a leg per stop.")
                    }
                } else {
                    list
                }
            }
            .navigationTitle("Stops")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                if !store.stops.isEmpty {
                    // Reordering with .onMove requires an edit mode to enter.
                    ToolbarItem(placement: .navigationBarLeading) {
                        EditButton()
                    }
                }
            }
        }
    }

    private var list: some View {
        List {
            Section {
                ForEach(Array(store.stops.enumerated()), id: \.element.id) { index, stop in
                    HStack(spacing: 10) {
                        Text("\(index + 1)")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(.white)
                            .frame(width: 22, height: 22)
                            .background(Color.stopViolet, in: Circle())
                        Text(stop.label ?? "Stop \(index + 1)")
                            .font(.body)
                            .lineLimit(1)
                        Spacer(minLength: 0)
                    }
                }
                .onMove { source, destination in
                    Task { await store.moveStops(fromOffsets: source, toOffset: destination) }
                }
                .onDelete { offsets in
                    let ids = offsets.map { store.stops[$0].id }
                    Task { for id in ids { await store.removeStop(id: id) } }
                }
            } footer: {
                Text("Visited in this order. Drag to reorder — the route recomputes, and a better order is often much shorter.")
            }
        }
    }
}
