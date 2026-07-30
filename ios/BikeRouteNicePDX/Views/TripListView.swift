import SwiftUI

/// The trip as ONE ordered list: start → stops → destination, with "Add a stop"
/// hanging off the bottom.
///
///     ⬤ Home
///     ① New Seasons        ⋯
///     ② Powell's           ⋯
///     ⚑ Laurelhurst Park   ⋯
///      ＋ Add a stop
///
/// This replaces the two side-by-side pin chips plus a separate "N stops" chip
/// that opened its own sheet. The point is that the destination isn't a
/// different KIND of thing from a stop — it's just the last place the rider
/// visits — so both live in one list and a row's role is editable from its menu
/// rather than being decided before the place is even picked.
///
/// Tapping a row sets `searchTarget`, which is what tells `SearchSheet` what
/// it's setting. The sheet no longer asks. Mirrors `EndpointInputs.tsx` on web.
struct TripListView: View {
    @Environment(RouteStore.self) private var store
    /// Set to open `SearchSheet` aimed at a specific row.
    @Binding var searchTarget: SearchTarget?
    /// Opens `StopsView` for drag-reorder, which needs a `List` + `EditButton`.
    var onReorder: () -> Void

    /// Stop rows are uniform, so capping the scroll area at a whole number of
    /// them is exact — no measuring needed. Four keeps the map usable at the
    /// 8-stop cap while a 1–4 stop trip still shows in full with no scrolling.
    private let stopRowHeight: CGFloat = 44
    private let maxVisibleStops = 4

    /// A stop only makes sense once the trip has both ends, and only under the
    /// cap. This gate is the whole point: before there's a destination there is
    /// nothing to put a stop BETWEEN, so the affordance doesn't exist yet.
    private var canAddStop: Bool {
        store.start != nil && store.end != nil && store.stops.count < RouteStore.maxStops
    }

    var body: some View {
        VStack(spacing: 6) {
            startRow
            if !store.stops.isEmpty { stopRows }
            destinationRow
            if canAddStop { addStopButton }
        }
    }

    // MARK: - Rows

    private var startRow: some View {
        tripRow(
            badge: AnyView(
                Image(systemName: "figure.outdoor.cycle")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(store.start == nil ? Color.secondary : .green)
                    .frame(width: 22, height: 22)
            ),
            title: store.start?.label ?? "Set start",
            isSet: store.start != nil,
            action: { searchTarget = .start },
            menu: nil
        )
    }

    private var stopRows: some View {
        let stops = store.stops
        let visible = min(stops.count, maxVisibleStops)
        return ScrollView {
            VStack(spacing: 6) {
                ForEach(Array(stops.enumerated()), id: \.element.id) { index, stop in
                    tripRow(
                        badge: AnyView(
                            Text("\(index + 1)")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(.white)
                                .frame(width: 22, height: 22)
                                .background(Color.stopViolet, in: Circle())
                        ),
                        title: stop.label ?? "Stop \(index + 1)",
                        isSet: true,
                        action: { searchTarget = .editStop(stop.id) },
                        menu: AnyView(stopMenu(stop: stop, index: index, count: stops.count))
                    )
                }
            }
        }
        .frame(height: CGFloat(visible) * stopRowHeight)
        // Don't rubber-band a list that already fits.
        .scrollBounceBehavior(.basedOnSize)
    }

    private var destinationRow: some View {
        tripRow(
            badge: AnyView(
                Image(systemName: "flag.checkered")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(store.end == nil ? Color.secondary : .red)
                    .frame(width: 22, height: 22)
            ),
            title: store.end?.label ?? "Set destination",
            isSet: store.end != nil,
            action: { searchTarget = .end },
            menu: store.end == nil ? nil : AnyView(destinationMenu)
        )
    }

    private var addStopButton: some View {
        Button {
            searchTarget = .stop
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "plus.circle")
                Text("Add a stop")
                Spacer(minLength: 0)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Color.stopViolet)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.stopViolet.opacity(0.4), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Menus

    private func stopMenu(stop: Via, index: Int, count: Int) -> some View {
        Menu {
            Button {
                Task { await store.moveStop(id: stop.id, delta: -1) }
            } label: { Label("Move up", systemImage: "arrow.up") }
                .disabled(index == 0)

            Button {
                Task { await store.moveStop(id: stop.id, delta: 1) }
            } label: { Label("Move down", systemImage: "arrow.down") }
                .disabled(index == count - 1)

            if count > 1 {
                Button {
                    onReorder()
                } label: { Label("Reorder stops…", systemImage: "list.bullet.indent") }
            }

            Button {
                Task { await store.promoteStopToDestination(id: stop.id) }
            } label: { Label("Make this the destination", systemImage: "flag.checkered") }

            Button(role: .destructive) {
                Task { await store.removeStop(id: stop.id) }
            } label: { Label("Remove stop", systemImage: "trash") }
        } label: {
            menuGlyph
        }
        .accessibilityLabel("Stop \(index + 1) options")
    }

    @ViewBuilder
    private var destinationMenu: some View {
        Menu {
            if let last = store.stops.last {
                // Swapping with the LAST stop is what "demote" means: the place
                // you were finishing at becomes the final errand instead.
                Button {
                    Task { await store.promoteStopToDestination(id: last.id) }
                } label: { Label("Make this a stop", systemImage: "mappin.and.ellipse") }
            }
            Button(role: .destructive) {
                store.clearAll()
            } label: { Label("Clear route", systemImage: "trash") }
        } label: {
            menuGlyph
        }
        .accessibilityLabel("Destination options")
    }

    private var menuGlyph: some View {
        Image(systemName: "ellipsis")
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: 32, height: 32)
            .contentShape(Rectangle())
    }

    // MARK: - Row shell

    private func tripRow(
        badge: AnyView,
        title: String,
        isSet: Bool,
        action: @escaping () -> Void,
        menu: AnyView?
    ) -> some View {
        HStack(spacing: 8) {
            Button(action: action) {
                HStack(spacing: 10) {
                    badge
                    Text(title)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                        .foregroundStyle(isSet ? .primary : .secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.primary.opacity(0.06))
                )
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let menu { menu }
        }
    }
}
