import Foundation
import WatchConnectivity

/// Phone side of the watch companion. Pushes the latest next-maneuver state to a
/// paired Apple Watch via `updateApplicationContext` (coalesces to the newest
/// value — exactly what a glanceable next-turn card wants). No-ops with no watch.
///
/// The watch decides when to play a wrist-tap from the `maneuverChangeToken`
/// (incremented by the phone each time the active maneuver changes).
@MainActor
final class WatchBridge: NSObject, WCSessionDelegate {
    static let shared = WatchBridge()

    private var lastManeuverKey: String?
    private var maneuverChangeToken = 0
    private var activated = false

    private override init() {
        super.init()
        activate()
    }

    private func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        activated = true
    }

    func send(_ nav: NavigationSession) {
        guard activated, WCSession.default.activationState == .activated else { return }
        let step = nav.nextStep
        // A "maneuver changed" key so the watch knows when to buzz.
        let key = "\(nav.currentStepIndex)|\(step?.maneuver_type ?? "")"
        if key != lastManeuverKey {
            lastManeuverKey = key
            maneuverChangeToken += 1
        }
        let context: [String: Any] = [
            "navigating": true,
            "symbol": ManeuverStyle.symbol(step?.maneuver_type ?? "arrow.up"),
            "instruction": nav.arrived ? "Arrived" : (step?.instruction ?? "Continue"),
            "distanceToTurn": nav.distanceToNextLabel,
            "eta": nav.etaLabel,
            "distanceRemaining": nav.distanceRemainingLabel,
            "rerouting": nav.isRerouting,
            "arrived": nav.arrived,
            "turnToken": maneuverChangeToken
        ]
        try? WCSession.default.updateApplicationContext(context)
    }

    func sendEnd() {
        guard activated, WCSession.default.activationState == .activated else { return }
        lastManeuverKey = nil
        try? WCSession.default.updateApplicationContext(["navigating": false])
    }

    // MARK: - WCSessionDelegate (required; nothing to handle phone-side)

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }
}
