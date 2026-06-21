import ActivityKit
import WidgetKit
import SwiftUI

/// The turn-by-turn Live Activity: a next-maneuver card on the lock screen and a
/// compact next-turn glance in the Dynamic Island. Driven by `NavActivityAttributes`
/// (shared with the app target).
struct NavLiveActivity: Widget {
    private var brandGreen: Color { Color(red: 0.13, green: 0.55, blue: 0.30) }

    var body: some WidgetConfiguration {
        ActivityConfiguration(for: NavActivityAttributes.self) { context in
            lockScreen(context.state)
                .padding(16)
                .activityBackgroundTint(brandGreen.opacity(0.16))
                .activitySystemActionForegroundColor(brandGreen)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: context.state.maneuverSymbol)
                        .font(.title2)
                        .foregroundStyle(brandGreen)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    VStack(alignment: .trailing, spacing: 1) {
                        Text(context.state.eta).font(.headline)
                        Text(context.state.distanceRemaining)
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    Text(context.state.arrived ? "Arrived" :
                        (context.state.rerouting ? "Rerouting…" : context.state.instruction))
                        .font(.subheadline.weight(.medium))
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } compactLeading: {
                Image(systemName: context.state.maneuverSymbol).foregroundStyle(brandGreen)
            } compactTrailing: {
                Text(context.state.distanceToTurn).font(.caption2)
            } minimal: {
                Image(systemName: context.state.maneuverSymbol).foregroundStyle(brandGreen)
            }
        }
    }

    @ViewBuilder
    private func lockScreen(_ state: NavActivityAttributes.ContentState) -> some View {
        HStack(spacing: 14) {
            Image(systemName: state.maneuverSymbol)
                .font(.system(size: 30, weight: .bold))
                .foregroundStyle(brandGreen)
                .frame(width: 42)
            VStack(alignment: .leading, spacing: 2) {
                Text(state.rerouting ? "Rerouting…" : state.distanceToTurn)
                    .font(.headline)
                Text(state.arrived ? "Arrived" : state.instruction)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 2) {
                Text(state.eta).font(.headline).monospacedDigit()
                Text(state.distanceRemaining)
                    .font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }
    }
}
