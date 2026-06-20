import SwiftUI

/// Collapsible legend for the bike-network overlay. Tap to expand/collapse.
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
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(BikeClass.legendOrder, id: \.self) { cls in
                        HStack(spacing: 8) {
                            swatch(for: cls)
                            Text(cls.label)
                                .font(.caption2)
                                .foregroundStyle(.primary)
                        }
                    }

                    Divider().padding(.vertical, 2)

                    Text("Your route")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                    ForEach(routeLegendRows, id: \.label) { row in
                        HStack(spacing: 8) {
                            routeSwatch(color: row.color, dashed: row.dashed)
                            Text(row.label)
                                .font(.caption2)
                                .foregroundStyle(.primary)
                        }
                    }
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

    /// 4-tier route color key, matching the colored route line.
    private var routeLegendRows: [(label: String, color: UIColor, dashed: Bool)] {
        [
            ("Protected / Greenway / Path", FriendlyTier.green.color, false),
            ("Bike lane / Buffered", FriendlyTier.amber.color, false),
            ("Quiet street", FriendlyTier.calm.color, false),
            ("Busy street — no bike lane", FriendlyTier.red.color, true),
        ]
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
            .frame(width: 22, height: cls == .shared ? 3 : 4)
            .opacity(cls == .shared ? 0.7 : 1)
            .overlay(alignment: .center) {
                // Hint the dashed style of "shared" facilities.
                if cls == .shared {
                    Capsule()
                        .fill(Color(uiColor: .systemBackground))
                        .frame(width: 4, height: 4)
                }
            }
    }
}
