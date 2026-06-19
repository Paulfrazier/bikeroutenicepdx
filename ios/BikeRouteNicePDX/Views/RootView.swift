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

            VStack(spacing: 12) {
                Spacer()
                if !store.isDrawMode {
                    HStack {
                        Spacer()
                        locateButton
                    }
                }
                ControlsBar(showSearch: $showSearch)
            }
        }
        .sheet(isPresented: $showSearch) {
            SearchSheet()
                .presentationDetents([.medium, .large])
        }
        .task {
            #if DEBUG
            switch ProcessInfo.processInfo.environment["BRN_DEMO"] {
            case "1": await store.runDemoSnap()
            case "edit": await store.runDemoEdit()
            default: break
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

    private var locateButton: some View {
        Button {
            store.recenterOnUser()
        } label: {
            Image(systemName: "location.fill")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.tint)
                .frame(width: 46, height: 46)
                .background(.regularMaterial, in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.trailing, 12)
        .accessibilityLabel("Center on my location")
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
