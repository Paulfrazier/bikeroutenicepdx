import SwiftUI

/// Watch companion entry point. Receives next-turn updates from the paired iPhone
/// over WatchConnectivity and shows a glanceable card + wrist-tap haptic per turn.
@main
struct BikeNiceWatchApp: App {
    @State private var model = WatchNavModel()

    var body: some Scene {
        WindowGroup {
            WatchNavView()
                .environment(model)
                .onAppear {
                    WatchSessionManager.shared.onContext = { ctx in model.apply(ctx) }
                    WatchSessionManager.shared.activate()
                }
        }
    }
}
