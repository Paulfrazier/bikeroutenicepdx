import SwiftUI

/// Glanceable next-turn card on the wrist. Big maneuver arrow + distance, with ETA
/// and distance-remaining underneath. Idle prompt when no ride is active.
struct WatchNavView: View {
    @Environment(WatchNavModel.self) private var model

    private var brandGreen: Color { Color(red: 0.18, green: 0.62, blue: 0.28) }

    var body: some View {
        if !model.navigating {
            VStack(spacing: 8) {
                Image(systemName: "bicycle")
                    .font(.system(size: 34))
                    .foregroundStyle(brandGreen)
                Text("Start a ride on your iPhone")
                    .font(.caption2)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.secondary)
            }
            .padding()
        } else {
            VStack(spacing: 4) {
                Image(systemName: model.symbol)
                    .font(.system(size: 38, weight: .bold))
                    .foregroundStyle(brandGreen)
                Text(model.rerouting ? "Rerouting…" : model.distanceToTurn)
                    .font(.title3.weight(.bold))
                Text(model.arrived ? "Arrived" : model.instruction)
                    .font(.caption2)
                    .multilineTextAlignment(.center)
                    .lineLimit(3)
                    .foregroundStyle(.secondary)
                HStack {
                    Text(model.eta)
                    Spacer()
                    Text(model.distanceRemaining)
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            }
            .padding(.horizontal, 6)
        }
    }
}
