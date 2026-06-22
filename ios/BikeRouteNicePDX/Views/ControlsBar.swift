import SwiftUI

/// Bottom control card. Phase-driven: pin chips on top, a context action below.
struct ControlsBar: View {
    @Environment(RouteStore.self) private var store
    @Environment(NavigationSession.self) private var nav
    @Binding var showSearch: Bool
    @Binding var showDirections: Bool

    /// Whether the grouped reshape-mode selector (Drag/Draw/Through) is shown.
    /// The three modes used to be always-visible buttons; they're now collapsed
    /// behind one "Edit route" toggle so "Start ride" stays the clear primary.
    @State private var editPanelOpen = false

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
        // Auto-close the edit panel when the route goes away (clear / new pins).
        // Draw mode (.drawing) keeps it open so it's still open on return.
        .onChange(of: store.phase) { _, newPhase in
            switch newPhase {
            case .routed, .drawing, .snapping, .readyToDraw: break
            default: editPanelOpen = false
            }
        }
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
                    // Summary line carries the route stats plus the two utilities
                    // (turn-list count + clear) so the action row below is free to
                    // hold only the two primary buttons at full width.
                    HStack(spacing: 8) {
                        Label(snapped.distanceLabel, systemImage: "bicycle")
                            .font(.headline)
                        if !snapped.durationLabel.isEmpty {
                            Label(snapped.durationLabel, systemImage: "clock")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        if let coverage = snapped.coverage {
                            Text("🚲 \(Int((coverage * 100).rounded()))%")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        } else {
                            Text(routeCaption)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if !snapped.steps.isEmpty {
                            Button {
                                showDirections = true
                            } label: {
                                Label("\(snapped.steps.count)", systemImage: "list.bullet")
                                    .font(.subheadline.weight(.semibold))
                            }
                            .buttonStyle(.borderless)
                            .tint(.green)
                        }
                        Button(role: .destructive) {
                            store.clearAll()
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.title3)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("Clear route")
                    }
                }
                preferencePicker
                // Action row: just the two primary CTAs, equal width via
                // frame(maxWidth:.infinity), uniform height via controlSize +
                // shared font. lineLimit keeps both labels on one line.
                HStack(spacing: 10) {
                    Button {
                        nav.start()
                    } label: {
                        Label("Start", systemImage: "location.north.line.fill")
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                    editToggleButton
                }
                .controlSize(.large)
                .font(.subheadline.weight(.semibold))
                if editPanelOpen {
                    editToolsRow
                    if let hintText = activeReshapeHint {
                        hint(hintText)
                    }
                }
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

    /// The single "Edit route" / "Done editing" toggle that the three reshape
    /// tools now live behind. Opening defaults to Drag (preserves the old
    /// one-tap-to-drag behavior); closing clears every reshape mode.
    private var editToggleButton: some View {
        Button {
            if editPanelOpen {
                editPanelOpen = false
                store.exitReshapeModes()
            } else {
                editPanelOpen = true
                store.enterEditMode()
            }
        } label: {
            Label(
                editPanelOpen ? "Done" : "Edit",
                systemImage: editPanelOpen ? "checkmark" : "pencil"
            )
            .lineLimit(1)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.bordered)
        .tint(editPanelOpen ? .green : .blue)
    }

    /// Segmented selector among the three reshape modes — exactly one active at a
    /// time (mutual exclusivity lives in RouteStore). Drag re-snaps a dragged
    /// line; Draw enters freehand-draw (.drawing phase); Through forces the route
    /// through a tapped section.
    private var editToolsRow: some View {
        HStack(spacing: 6) {
            editToolButton("Drag", icon: "hand.point.up.left.fill", active: store.isEditMode) {
                store.enterEditMode()
            }
            editToolButton("Draw", icon: "hand.draw.fill", active: store.isDrawMode) {
                store.enterDrawMode()
            }
            editToolButton(
                "Through",
                icon: "point.topleft.down.to.point.bottomright.curvepath",
                active: store.isCorridorMode
            ) {
                if !store.isCorridorMode { store.toggleCorridorMode() }
            }
        }
    }

    private func editToolButton(
        _ title: String,
        icon: String,
        active: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Image(systemName: icon)
                    .font(.subheadline)
                Text(title)
                    .font(.caption2.weight(.semibold))
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .foregroundStyle(active ? Color.white : Color.primary)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(active ? Color.green : Color.primary.opacity(0.06))
            )
        }
        .buttonStyle(.plain)
    }

    /// Contextual hint for the active reshape mode. Draw has its own (.drawing
    /// phase) hint, so it isn't covered here.
    private var activeReshapeHint: String? {
        if store.isEditMode {
            return "Drag the route on the map to reshape it — it re-snaps to roads."
        }
        if store.isCorridorMode {
            return "Tap the start then the end of a section on the map."
        }
        return nil
    }

    private var clearAllButton: some View {
        Button(role: .destructive) {
            store.clearAll()
        } label: {
            Image(systemName: "trash")
        }
        .buttonStyle(.bordered)
    }
}
