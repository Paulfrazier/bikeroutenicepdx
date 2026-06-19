import SwiftUI

@main
struct BikeRouteNicePDXApp: App {
    @State private var store = RouteStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
        }
    }
}
