import ActivityKit

/// Drives the lock-screen / Dynamic Island Live Activity from `NavigationSession`.
/// No-ops gracefully when Live Activities are disabled or unavailable.
///
/// ActivityKit's `Activity` is a non-Sendable class, so under Swift 6 strict
/// concurrency we keep it inside an `@unchecked Sendable` box — ActivityKit's own
/// update/end calls are internally thread-safe, so handing the box to a Task is
/// safe even though the compiler can't prove it.
@MainActor
final class LiveActivityController {
    static let shared = LiveActivityController()
    private init() {}

    private final class ActivityBox: @unchecked Sendable {
        let activity: Activity<NavActivityAttributes>
        init(_ activity: Activity<NavActivityAttributes>) { self.activity = activity }
    }

    private var box: ActivityBox?

    func start(_ nav: NavigationSession) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        end()
        let content = ActivityContent(state: makeState(nav), staleDate: nil)
        if let activity = try? Activity.request(
            attributes: NavActivityAttributes(title: "BikeRoute PDX"),
            content: content
        ) {
            box = ActivityBox(activity)
        }
    }

    func update(_ nav: NavigationSession) {
        guard let box else { return }
        let state = makeState(nav)
        Task { await box.activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    func end() {
        guard let box else { return }
        self.box = nil
        Task { await box.activity.end(nil, dismissalPolicy: .immediate) }
    }

    private func makeState(_ nav: NavigationSession) -> NavActivityAttributes.ContentState {
        let step = nav.nextStep
        return NavActivityAttributes.ContentState(
            maneuverSymbol: ManeuverStyle.symbol(step?.maneuver_type ?? "arrow.up"),
            instruction: nav.arrived ? "Arrived" : (step?.instruction ?? "Continue"),
            distanceToTurn: nav.distanceToNextLabel,
            eta: nav.etaLabel,
            distanceRemaining: nav.distanceRemainingLabel,
            rerouting: nav.isRerouting,
            arrived: nav.arrived
        )
    }
}
