import ActivityKit

/// Shared Live Activity model — compiled into BOTH the app (to start/update the
/// activity) and the widget extension (to render it). Keep it dependency-free.
struct NavActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// SF Symbol for the next maneuver (from `ManeuverStyle.symbol`).
        var maneuverSymbol: String
        var instruction: String
        var distanceToTurn: String
        var eta: String
        var distanceRemaining: String
        var rerouting: Bool
        var arrived: Bool
    }

    /// Static for the life of the activity.
    var title: String
}
