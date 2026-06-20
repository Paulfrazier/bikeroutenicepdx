import SwiftUI

struct RootView: View {
    @Environment(RouteStore.self) private var store
    @State private var showSearch = false
    @State private var showDirections = false

    // Help: first-run tour (auto-shown once) + reopenable gesture guide.
    @AppStorage("tourSeen_v1") private var tourSeen = false
    @State private var showTour = false
    @State private var showGuide = false

    var body: some View {
        ZStack(alignment: .top) {
            MapView()
                .ignoresSafeArea()

            HStack(alignment: .top) {
                helpButton
                    .padding(.leading, 12)
                    .padding(.top, 8)
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
                // Corridor pick/confirm sits just above the controls — in the
                // thumb zone — since "Route through here" is a commit action, not
                // passive status (top is a reach + far from where the eye is).
                corridorBanner
                ControlsBar(showSearch: $showSearch, showDirections: $showDirections)
            }
        }
        .sheet(isPresented: $showSearch) {
            SearchSheet()
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showDirections) {
            DirectionsSheet(
                steps: store.snapped?.steps ?? [],
                distanceLabel: store.snapped?.distanceLabel ?? ""
            )
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showGuide) {
            GestureGuideView(
                onClose: { showGuide = false },
                onReplayTour: {
                    showGuide = false
                    // Defer so the guide sheet finishes dismissing first.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        showTour = true
                    }
                }
            )
            .presentationDetents([.large])
        }
        .fullScreenCover(isPresented: $showTour) {
            TourView(onClose: {
                tourSeen = true
                showTour = false
            })
        }
        .onAppear {
            #if DEBUG
            // Verification hooks (no touch injection in the sim): force a help
            // surface open without needing the first-run flag or a tap.
            switch ProcessInfo.processInfo.environment["BRN_HELP"] {
            case "tour": showTour = true; return
            case "guide": showGuide = true; return
            default: break
            }
            #endif
            if !tourSeen { showTour = true }
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

    /// "Route through a section" (corridor) pick banner — the analog of the web
    /// `.corridor-bar` overlay. Walks the same states: tap A → tap B → finding →
    /// confirm/cancel (or error). Reading the corridor state here also keeps the
    /// MapView's overlay in sync (its updateUIView fires when this re-renders).
    @ViewBuilder
    private var corridorBanner: some View {
        if store.isCorridorMode {
            VStack(spacing: 10) {
                if store.corridorPreview != nil {
                    Text("Route through this section?")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 12) {
                        Button {
                            Task { await store.confirmCorridor() }
                        } label: {
                            Text("Route through here")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.teal)
                        Button {
                            store.cancelCorridorPick()
                        } label: {
                            Text("Cancel")
                                .font(.subheadline.weight(.medium))
                                .padding(.vertical, 10)
                                .padding(.horizontal, 16)
                        }
                        .buttonStyle(.bordered)
                    }
                } else if store.corridorLoading {
                    Label("Finding the street…", systemImage: "point.topleft.down.to.point.bottomright.curvepath")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if let error = store.corridorError {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if store.corridorA != nil {
                    Text("Now tap the **end** of the section")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Text("Tap the **start** of the section on a street")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(.horizontal, 16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// "?" button that opens the gesture guide (which can replay the tour).
    private var helpButton: some View {
        Button {
            showGuide = true
        } label: {
            Image(systemName: "questionmark")
                .font(.system(size: 18, weight: .bold))
                .foregroundStyle(.tint)
                .frame(width: 40, height: 40)
                .background(.regularMaterial, in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("How to use the map")
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
