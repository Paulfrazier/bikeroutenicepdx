import SwiftUI

/// "Saved places" — the manage sheet for the rider's starred places. Picking a
/// saved place happens in `SearchSheet`; this sheet is for curation: rename,
/// reorder, delete.
///
/// Mirrors `ConnectorsView.swift` (sheet + NotificationCenter refresh) and the
/// web `Favorites.tsx` panel.
struct FavoritesView: View {
    @Environment(\.dismiss) private var dismiss

    /// Local mirror of the store, reloaded on every mutation (and when the sheet
    /// appears) so the list reflects places starred from the search sheet too.
    @State private var rows: [FavoritePlace] = Favorites.list()

    // Rename flow.
    @State private var renaming: FavoritePlace?
    @State private var renameText = ""

    var body: some View {
        NavigationStack {
            Group {
                if rows.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("Saved places")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                // Reordering with .onMove requires an edit mode to enter.
                if !rows.isEmpty {
                    ToolbarItem(placement: .navigationBarLeading) {
                        EditButton()
                    }
                }
            }
            .alert(
                "Rename place",
                isPresented: Binding(
                    get: { renaming != nil },
                    set: { if !$0 { renaming = nil } }
                )
            ) {
                TextField("Name", text: $renameText)
                Button("Save") {
                    if let f = renaming {
                        Favorites.rename(f.id, renameText)
                    }
                    renaming = nil
                }
                Button("Cancel", role: .cancel) { renaming = nil }
            } message: {
                Text("Short names work best — Home, School, Work.")
            }
            .onAppear { rows = Favorites.list() }
            .onReceive(NotificationCenter.default.publisher(for: .favoritesChanged)) { _ in
                rows = Favorites.list()
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("No saved places", systemImage: "star")
        } description: {
            Text("Search for a place, then tap the ☆ beside any result to save it. Saved places appear at the top of every search.")
        }
    }

    private var list: some View {
        List {
            Section {
                ForEach(rows) { favorite in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(favorite.name)
                            .font(.body.weight(.semibold))
                            .lineLimit(1)
                        // The geocoded address behind the nickname.
                        Text(addressLine(favorite))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Favorites.remove(favorite.id)
                        } label: {
                            Label("Remove", systemImage: "trash")
                        }
                        Button {
                            renameText = favorite.name
                            renaming = favorite
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                        .tint(.orange)
                    }
                }
                .onMove { source, destination in
                    Favorites.move(fromOffsets: source, toOffset: destination)
                }
                .onDelete { offsets in
                    for i in offsets { Favorites.remove(rows[i].id) }
                }
            } footer: {
                Text("Saved on this device only. Drag to reorder — the ones you use most belong at the top.")
            }
        }
    }

    private func addressLine(_ favorite: FavoritePlace) -> String {
        let place = favorite.place
        guard let context = place.context, !context.isEmpty else { return place.name }
        return "\(place.name) · \(context)"
    }
}
