import SwiftUI

struct RootView: View {
    @Environment(RouteStore.self) private var store
    @State private var showSearch = false

    var body: some View {
        ZStack(alignment: .top) {
            MapView()
                .ignoresSafeArea()

            HStack {
                Spacer()
                LegendView()
                    .padding(.trailing, 12)
                    .padding(.top, 8)
            }

            topBanner

            VStack {
                Spacer()
                ControlsBar(showSearch: $showSearch)
            }
        }
        .sheet(isPresented: $showSearch) {
            SearchSheet()
                .presentationDetents([.medium, .large])
        }
        .task {
            #if DEBUG
            if ProcessInfo.processInfo.environment["BRN_DEMO"] == "1" {
                await store.runDemoSnap()
            }
            #endif
        }
    }

    @ViewBuilder
    private var topBanner: some View {
        if store.isDrawMode {
            banner(
                icon: "hand.draw",
                text: "Trace your route with one finger — follow the colored bikeways."
            )
        } else if store.phase == .snapping {
            banner(icon: "point.topleft.down.curvedto.point.bottomright.up", text: "Snapping to the bike network…")
        }
    }

    private func banner(icon: String, text: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon)
            Text(text)
                .font(.subheadline.weight(.medium))
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .transition(.move(edge: .top).combined(with: .opacity))
    }
}
