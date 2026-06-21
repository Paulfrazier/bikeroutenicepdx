import Foundation
import WatchConnectivity

/// Watch side of the companion link. Receives the phone's latest application
/// context (next-turn state) and forwards it to the model on the main actor.
final class WatchSessionManager: NSObject, WCSessionDelegate {
    static let shared = WatchSessionManager()

    var onContext: (@MainActor ([String: Any]) -> Void)?

    private override init() { super.init() }

    func activate() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {}

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        let cb = onContext
        Task { @MainActor in cb?(applicationContext) }
    }
}
