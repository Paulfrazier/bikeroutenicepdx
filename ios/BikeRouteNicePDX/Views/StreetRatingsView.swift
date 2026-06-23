import SwiftUI

/// "My street ratings" — the manage sheet for the rider's personal, GLOBAL
/// per-street opinions. Each rating recolors every route and (for `avoid`)
/// lowers its comfort score. Names are shown normalized (uppercased, quadrant
/// prefix stripped) to communicate that a rating is one opinion across the city.
struct StreetRatingsView: View {
    @Environment(\.dismiss) private var dismiss

    /// Local mirror of the store, reloaded on every mutation (and when the sheet
    /// appears) so the list reflects ratings added via tap-to-rate too.
    @State private var rows: [(name: String, rating: StreetRating)] = StreetRatings.list()

    var body: some View {
        NavigationStack {
            Group {
                if rows.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("My street ratings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .streetRatingsChanged)) { _ in
            rows = StreetRatings.list()
        }
        .onAppear { rows = StreetRatings.list() }
    }

    private var list: some View {
        List {
            Section {
                ForEach(rows, id: \.name) { row in
                    HStack {
                        Text(row.name)
                            .font(.body)
                        Spacer()
                        ratingMenu(for: row.name, current: row.rating)
                    }
                }
                .onDelete { offsets in
                    for index in offsets { StreetRatings.remove(rows[index].name) }
                    rows = StreetRatings.list()
                }
            } footer: {
                Text("These ratings are personal and apply everywhere that street appears. Long-press a street on the map to rate it.")
            }
        }
    }

    /// A Menu to change a street's rating in place (or clear it).
    private func ratingMenu(for name: String, current: StreetRating) -> some View {
        Menu {
            Picker("Rating", selection: Binding(
                get: { current },
                set: { newValue in
                    StreetRatings.set(newValue, for: name)
                    rows = StreetRatings.list()
                }
            )) {
                ForEach(StreetRating.allCases) { rating in
                    Text(rating.label).tag(rating)
                }
            }
            Divider()
            Button("Clear rating", role: .destructive) {
                StreetRatings.remove(name)
                rows = StreetRatings.list()
            }
        } label: {
            HStack(spacing: 6) {
                Circle()
                    .fill(Color(uiColor: current.routeClass.color))
                    .frame(width: 12, height: 12)
                Text(current.label)
                    .font(.subheadline.weight(.medium))
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 44))
                .foregroundStyle(.green)
            Text("No street ratings yet")
                .font(.headline)
            Text("Long-press a street on the map to give it a personal rating — Great, Good, Meh, or Avoid. Your ratings recolor every route you plan and adjust its comfort score.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
