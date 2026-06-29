import SwiftUI

/// Compact "Comfort Lens" legend for the bike-network overlay. Tap the header to
/// collapse/expand. The body is one comfort dial (Calm / Balanced / All) plus a
/// Quiet-streets toggle — the five per-group checkboxes now live behind
/// "Customize" (`ComfortCustomizeSheet`). Mirrors the web Comfort Lens legend.
/// All state flows through `RouteStore.hiddenLaneGroups` (the canonical Set);
/// the presets/quiet-streets bit are derived views over it.
struct LegendView: View {
    @Environment(RouteStore.self) private var store
    @State private var expanded = true
    @State private var showCustomize = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "bicycle")
                    Text("Bike map")
                        .font(.caption.weight(.semibold))
                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(expanded ? "Hide bike map key" : "Show bike map key")

            if expanded {
                VStack(alignment: .leading, spacing: 10) {
                    presetPicker

                    Text(summaryText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Button {
                        showCustomize = true
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: "gearshape")
                            Text("Customize")
                        }
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.tint)
                        .frame(minHeight: 30)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Customize map layers")
                }
                .frame(width: 188, alignment: .leading)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
        .onChange(of: store.phase) { _, newPhase in
            // Get the key out of the way the moment a route starts computing.
            // Transition-only, so a deliberate re-expand isn't fought.
            if newPhase == .snapping {
                withAnimation(.snappy(duration: 0.2)) { expanded = false }
            }
        }
        .sheet(isPresented: $showCustomize) {
            ComfortCustomizeSheet()
                .presentationDetents([.height(420), .large])
                .presentationDragIndicator(.visible)
        }
    }

    /// Three-button segmented control for the comfort dial. A real
    /// `.pickerStyle(.segmented)` can't render "no selection", so this is a custom
    /// segmented row: the active preset fills with the tint; when the hidden Set
    /// matches no preset (`comfortPreset == nil`, "Custom") NO segment is filled.
    private var presetPicker: some View {
        let active = store.comfortPreset
        return HStack(spacing: 0) {
            ForEach(ComfortPreset.allCases, id: \.self) { preset in
                let isOn = active == preset
                Button {
                    withAnimation(.snappy(duration: 0.15)) { store.setComfortPreset(preset) }
                } label: {
                    Text(preset.pickerLabel)
                        .font(.caption.weight(isOn ? .semibold : .regular))
                        .foregroundStyle(isOn ? AnyShapeStyle(.white) : AnyShapeStyle(.primary))
                        .frame(maxWidth: .infinity, minHeight: 30)
                        .background {
                            if isOn {
                                RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    .fill(.tint)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(preset.pickerLabel) comfort\(isOn ? ", selected" : "")")
                .accessibilityAddTraits(isOn ? .isSelected : [])
            }
        }
        .padding(2)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color(uiColor: .tertiarySystemFill))
        )
    }

    /// One-line description of what the active preset shows on the map.
    private var summaryText: String {
        store.comfortPreset?.summary ?? "Custom selection."
    }
}

/// The full "Map layers" detail, moved out of the compact card. Hosts the five
/// independent lane-group checkboxes (each = a header toggle over its indented
/// member swatch rows) plus the route-only "Quiet street" key and the caption.
/// Presented as a sheet from the legend's Customize button.
struct ComfortCustomizeSheet: View {
    @Environment(RouteStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(LaneGroup.allCases, id: \.self) { group in
                        groupSection(group)
                    }

                    // Off-network route state (no network class of its own): a
                    // calm street the route uses that carries no bike facility.
                    HStack(spacing: 8) {
                        LegendSwatches.routeSwatch(color: RouteClass.quiet.color, dashed: false)
                        Text("Quiet street")
                            .font(.caption2)
                            .foregroundStyle(.primary)
                    }

                    Divider().padding(.vertical, 2)

                    Text("Uncheck a group to hide those lanes from the map. Your route is drawn in these colors with a white outline.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
            }
            .navigationTitle("Map layers")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// A lane-type group: a checkbox header (toggles visibility) over its
    /// indented member facility rows. Hidden groups dim to read as "off".
    private func groupSection(_ group: LaneGroup) -> some View {
        let hidden = store.hiddenLaneGroups.contains(group)
        return VStack(alignment: .leading, spacing: 5) {
            Button {
                store.toggleLaneGroup(group)
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: hidden ? "square" : "checkmark.square.fill")
                        .foregroundStyle(hidden ? AnyShapeStyle(.secondary) : AnyShapeStyle(.tint))
                    Text(group.label)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.primary)
                }
                .frame(minHeight: 28, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(group.label), \(hidden ? "hidden" : "shown")")
            .accessibilityAddTraits(hidden ? [] : .isSelected)

            VStack(alignment: .leading, spacing: 5) {
                ForEach(group.classes, id: \.self) { cls in
                    HStack(spacing: 8) {
                        LegendSwatches.swatch(for: cls)
                        Text(cls.label)
                            .font(.caption2)
                            .foregroundStyle(.primary)
                    }
                }
            }
            .padding(.leading, 24)
            .opacity(hidden ? 0.4 : 1)
        }
    }
}

/// Shared swatch builders so the compact card and the Customize sheet draw the
/// network key identically (one source for the colors/dashed treatment).
enum LegendSwatches {
    static func routeSwatch(color: UIColor, dashed: Bool) -> some View {
        Capsule()
            .fill(Color(uiColor: color))
            .frame(width: 22, height: 4)
            .opacity(dashed ? 0.85 : 1)
            .overlay(alignment: .center) {
                if dashed {
                    Capsule()
                        .fill(Color(uiColor: .systemBackground))
                        .frame(width: 4, height: 4)
                }
            }
    }

    static func swatch(for cls: BikeClass) -> some View {
        Capsule()
            .fill(Color(uiColor: cls.color))
            .frame(width: 22, height: 4)
            .opacity(cls.dashed ? 0.85 : 1)
            .overlay(alignment: .center) {
                // Hint the dashed style of no-facility (shared/calm/busy) classes.
                if cls.dashed {
                    Capsule()
                        .fill(Color(uiColor: .systemBackground))
                        .frame(width: 4, height: 4)
                }
            }
    }
}

/// UI-only labels for the comfort dial + its one-line summary. Kept here (not on
/// the canonical `ComfortPreset`) so the enum stays a pure data type.
private extension ComfortPreset {
    var pickerLabel: String {
        switch self {
        case .gentle: return "Gentle"
        case .medium: return "Medium"
        case .all: return "All"
        }
    }

    var summary: String {
        switch self {
        case .gentle: return "Protected lanes, greenways & paths only."
        case .medium: return "Adds painted lanes & mostly-calm streets."
        case .all: return "Adds busy roads with little bike infrastructure."
        }
    }
}
