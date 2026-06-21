import SwiftUI
import WatchKit

/// Holds the latest next-turn state pushed from the phone. Plays a wrist-tap when
/// the active maneuver changes (the phone increments `turnToken` on each change).
@MainActor
@Observable
final class WatchNavModel {
    var navigating = false
    var symbol = "arrow.up"
    var instruction = "—"
    var distanceToTurn = ""
    var eta = ""
    var distanceRemaining = ""
    var rerouting = false
    var arrived = false

    private var lastTurnToken = 0

    func apply(_ ctx: [String: Any]) {
        let nowNavigating = ctx["navigating"] as? Bool ?? false
        navigating = nowNavigating
        guard nowNavigating else { return }
        symbol = ctx["symbol"] as? String ?? "arrow.up"
        instruction = ctx["instruction"] as? String ?? "—"
        distanceToTurn = ctx["distanceToTurn"] as? String ?? ""
        eta = ctx["eta"] as? String ?? ""
        distanceRemaining = ctx["distanceRemaining"] as? String ?? ""
        rerouting = ctx["rerouting"] as? Bool ?? false
        arrived = ctx["arrived"] as? Bool ?? false
        let token = ctx["turnToken"] as? Int ?? 0
        if token != lastTurnToken {
            lastTurnToken = token
            WKInterfaceDevice.current().play(arrived ? .success : .notification)
        }
    }
}
