import SwiftUI

@main
struct BikeRouteNicePDXApp: App {
    @State private var store = RouteStore()
    @State private var nav = NavigationSession()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(nav)
                .onAppear { nav.bind(store) }
                .onChange(of: scenePhase) { _, phase in
                    nav.syncScreenWake(foreground: phase == .active)
                }
        }
    }
}
