import SwiftUI

/// Turn-by-turn directions for the current route. Each step shows the maneuver,
/// the instruction (with street name), distance, and a greenway/bike-infra pill.
struct DirectionsSheet: View {
    let steps: [RouteStep]
    let distanceLabel: String
    /// Per-stop breakdown; groups the steps under a leg header when the trip has
    /// stops. Empty on a plain A→B route. Mirrors the web DirectionsPanel.
    var legs: [RouteLeg] = []

    var body: some View {
        NavigationStack {
            Group {
                if steps.isEmpty {
                    ContentUnavailableView(
                        "No directions",
                        systemImage: "arrow.triangle.turn.up.right.diamond",
                        description: Text("Directions appear once a route is computed.")
                    )
                } else if legs.isEmpty {
                    List {
                        ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                            row(step)
                        }
                    }
                    .listStyle(.plain)
                } else {
                    List {
                        ForEach(Array(legs.enumerated()), id: \.offset) { legIndex, leg in
                            Section {
                                ForEach(stepsInLeg(legIndex), id: \.offset) { entry in
                                    row(entry.element)
                                }
                            } header: {
                                legHeader(legIndex, leg)
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                }
            }
            .navigationTitle("Directions · \(distanceLabel)")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    /// Steps belonging to one leg, keeping their global offsets as stable ids.
    private func stepsInLeg(_ legIndex: Int) -> [(offset: Int, element: RouteStep)] {
        Array(steps.enumerated())
            .filter { $0.element.leg_index == legIndex }
            .map { (offset: $0.offset, element: $0.element) }
    }

    private func legHeader(_ index: Int, _ leg: RouteLeg) -> some View {
        HStack {
            Text(index == 0 ? "To \(legDestination(leg))" : "Then to \(legDestination(leg))")
                .font(.footnote.weight(.bold))
                .foregroundStyle(Color(red: 0.486, green: 0.227, blue: 0.929)) // #7c3aed
            Spacer()
            Text("\(stepDistance(leg.distance_m)) · \(durationLabel(leg.duration_s))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .textCase(nil)
    }

    private func legDestination(_ leg: RouteLeg) -> String {
        leg.to_label ?? "your destination"
    }

    private func durationLabel(_ seconds: Double) -> String {
        let min = Int((seconds / 60).rounded())
        if min < 60 { return "\(min) min" }
        return "\(min / 60) h \(min % 60) min"
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
