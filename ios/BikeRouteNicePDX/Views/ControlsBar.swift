import SwiftUI

/// Bottom control card. Phase-driven: pin chips on top, a context action below.
struct ControlsBar: View {
    @Environment(RouteStore.self) private var store
    @Binding var showSearch: Bool
    @Binding var showDirections: Bool

    var body: some View {
        VStack(spacing: 12) {
            pinChips
            actionArea
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    // MARK: - Pin chips

    private var pinChips: some View {
        HStack(spacing: 10) {
            pinChip(
                title: store.start?.label ?? "Set start",
                isSet: store.start != nil,
                color: .green,
                icon: "figure.outdoor.cycle"
            )
            pinChip(
                title: store.end?.label ?? "Set destination",
                isSet: store.end != nil,
                color: .red,
                icon: "flag.checkered"
            )
        }
    }

    private func pinChip(title: String, isSet: Bool, color: Color, icon: String) -> some View {
        Button {
            showSearch = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .foregroundStyle(isSet ? color : .secondary)
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .foregroundStyle(isSet ? .primary : .secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .padding(.horizontal, 12)
            .background(
                Capsule().fill(Color.primary.opacity(0.06))
            )
            .overlay(
                Capsule().stroke(isSet ? color.opacity(0.5) : .clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Action area

    @ViewBuilder
    private var actionArea: some View {
        switch store.phase {
        case .idle, .settingStart:
            VStack(spacing: 10) {
                useLocationButton
                hint("…or tap the map / search to set your start.")
            }
        case .settingEnd:
            hint("Now tap the map to drop your destination — or search.")
        case .readyToDraw:
            // Both pins are set — the route is auto-computing (debounced). Show
            // the same working state as .snapping rather than a manual gate.
            routingSpinner
        case .drawing:
            HStack(spacing: 12) {
                secondaryButton("Cancel") { store.clearDraw() }
                hint("Drag one finger from start to finish.")
            }
        case .snapping:
            routingSpinner
        case .routed:
            VStack(spacing: 10) {
                if let snapped = store.snapped {
                    HStack {
                        Label(snapped.distanceLabel, systemImage: "bicycle")
                            .font(.headline)
                        Spacer()
                        if let coverage = snapped.coverage {
                            Text("🚲 \(Int((coverage * 100).rounded()))% comfortable")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        } else {
                            Text(routeCaption)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                preferencePicker
                if let steps = store.snapped?.steps, !steps.isEmpty {
                    Button {
                        showDirections = true
                    } label: {
                        Label("Directions (\(steps.count) steps)", systemImage: "list.bullet.rectangle")
                            .font(.subheadline.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered)
                    .tint(.green)
                }
                if store.isEditMode {
                    hint("Drag the route to reshape it — it re-snaps to roads.")
                }
                HStack(spacing: 12) {
                    clearAllButton
                    editButton
                    primaryButton("Draw", icon: "hand.draw.fill") {
                        store.enterDrawMode()
                    }
                }
                corridorButton
            }
        case .failed(let message):
            VStack(spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 12) {
                    clearAllButton
                    primaryButton("Try again", icon: "hand.draw.fill") {
                        store.enterDrawMode()
                    }
                }
            }
        }
    }

    // MARK: - Reusable bits

    /// Comfort↔Fast segmented control. Changing it recomputes the current route
    /// (RouteStore re-routes in its didSet).
    private var preferencePicker: some View {
        Picker(
            "Route style",
            selection: Binding(
                get: { store.routePreference },
                set: { store.routePreference = $0 }
            )
        ) {
            ForEach(RoutePreference.allCases) { pref in
                Text(pref.label).tag(pref)
            }
        }
        .pickerStyle(.segmented)
    }

    /// Caption under the routed distance. Reflects whether the route has been
    /// reshaped with drag-to-reshape via points.
    private var routeCaption: String {
        if store.isManuallyEdited {
            return "Reshaping…" // re-route in flight after a drag
        }
        let count = store.vias.count
        switch count {
        case 0: return "Snapped to greenways"
        case 1: return "Routed through 1 point"
        default: return "Routed through \(count) points"
        }
    }

    /// Set the route start to the user's current GPS location. After this the
    /// hint switches to "tap the map to drop your destination."
    private var useLocationButton: some View {
        Button {
            store.useMyLocationAsStart()
        } label: {
            Label("Use my location", systemImage: "location.fill")
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        }
        .buttonStyle(.borderedProminent)
        .tint(.green)
    }

    private var routingSpinner: some View {
        HStack(spacing: 10) {
            ProgressView()
            Text("Finding the friendliest route…")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
    }

    private func primaryButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        }
        .buttonStyle(.borderedProminent)
        .tint(.green)
    }

    private func secondaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
        }
        .buttonStyle(.bordered)
    }

    /// Toggle the route into/out of edit mode. Only in edit mode can the line be
    /// dragged to reshape — keeps it from moving by accident the rest of the time.
    private var editButton: some View {
        Button {
            store.isEditMode.toggle()
        } label: {
            Label(store.isEditMode ? "Done" : "Edit", systemImage: store.isEditMode ? "checkmark" : "hand.point.up.left.fill")
                .font(.subheadline.weight(.medium))
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
        }
        .buttonStyle(.bordered)
        .tint(store.isEditMode ? .green : .blue)
    }

    /// Toggle "route through a section" (corridor) mode: tap A then B on a street
    /// and the master route is forced through that section. Mutually exclusive
    /// with edit/draw; reads teal while active (mirrors the web).
    private var corridorButton: some View {
        Button {
            store.toggleCorridorMode()
        } label: {
            Label(
                store.isCorridorMode ? "Pick a section on the map" : "Route through a section",
                systemImage: "point.topleft.down.to.point.bottomright.curvepath"
            )
            .font(.subheadline.weight(.medium))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
        }
        .buttonStyle(.bordered)
        .tint(store.isCorridorMode ? .teal : .blue)
    }

    private var clearAllButton: some View {
        Button(role: .destructive) {
            store.clearAll()
        } label: {
            Image(systemName: "trash")
                .font(.headline)
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
        }
        .buttonStyle(.bordered)
    }
}
