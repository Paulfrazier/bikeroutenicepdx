import SwiftUI

@main
struct BikeRouteNicePDXApp: App {
    @State private var store = RouteStore()
    @State private var nav = NavigationSession()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(nav)
                .onAppear { nav.bind(store) }
        }
    }
}
