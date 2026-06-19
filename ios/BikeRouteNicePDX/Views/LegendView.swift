import SwiftUI

/// Collapsible legend for the bike-network overlay. Tap to expand/collapse.
struct LegendView: View {
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
            }
            .buttonStyle(.plain)

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
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 8, y: 3)
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
