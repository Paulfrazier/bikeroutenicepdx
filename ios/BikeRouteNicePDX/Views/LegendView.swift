import SwiftUI

/// Collapsible legend for the bike-network overlay. Tap to expand/collapse.
/// Each lane-type group has a checkbox header — unchecking it hides those lanes
/// from the network overlay (the route line is never filtered). Mirrors the web
/// legend (BikeNetworkLegend in Map.tsx).
struct LegendView: View {
    @Environment(RouteStore.self) private var store
    @State private var expanded = true

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
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
                    ForEach(LaneGroup.allCases, id: \.self) { group in
                        groupSection(group)
                    }

                    // Off-network route state (no network class of its own): a
                    // calm street the route uses that carries no bike facility.
                    HStack(spacing: 8) {
                        routeSwatch(color: RouteClass.quiet.color, dashed: false)
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
                        swatch(for: cls)
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

    private func routeSwatch(color: UIColor, dashed: Bool) -> some View {
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

    private func swatch(for cls: BikeClass) -> some View {
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
