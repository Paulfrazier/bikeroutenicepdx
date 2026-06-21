import SwiftUI

/// Turn-by-turn directions for the current route. Each step shows the maneuver,
/// the instruction (with street name), distance, and a greenway/bike-infra pill.
struct DirectionsSheet: View {
    let steps: [RouteStep]
    let distanceLabel: String

    var body: some View {
        NavigationStack {
            Group {
                if steps.isEmpty {
                    ContentUnavailableView(
                        "No directions",
                        systemImage: "arrow.triangle.turn.up.right.diamond",
                        description: Text("Directions appear once a route is computed.")
                    )
                } else {
                    List {
                        ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                            row(step)
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Directions · \(distanceLabel)")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func row(_ step: RouteStep) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: ManeuverStyle.symbol(step.maneuver_type))
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.green)
                .frame(width: 26, height: 26)

            VStack(alignment: .leading, spacing: 4) {
                Text(step.instruction)
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 8) {
                    Text(stepDistance(step.distance_m))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let pill = ManeuverStyle.pill(step.bicycle_network_class) {
                        Text(pill.label)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(pill.color.opacity(0.16), in: Capsule())
                            .foregroundStyle(pill.color)
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
    }

    // MARK: - Helpers

    private func stepDistance(_ meters: Double) -> String {
        let miles = meters / 1609.344
        if miles < 0.1 { return "\(Int((meters * 3.28084).rounded())) ft" }
        return String(format: "%.1f mi", miles)
    }
}
