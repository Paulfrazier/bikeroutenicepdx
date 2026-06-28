import SwiftUI

struct RootView: View {
    @Environment(RouteStore.self) private var store
    @Environment(NavigationSession.self) private var nav
    @State private var showSearch = false
    @State private var showDirections = false
    @State private var savedRide: Ride?
    @State private var showRideSaved = false

    // Help: first-run tour (auto-shown once) + reopenable gesture guide.
    @AppStorage("tourSeen_v1") private var tourSeen = false
    @State private var showTour = false
    @State private var showGuide = false
    @State private var showHistory = false
    @State private var showRatings = false
    @State private var showConnectors = false
    // Brief "no street here" hint after a rate long-press misses.
    @State private var showNoStreet = false
    // Confirm the resolved link roads before saving a tap-built connector.
    @State private var confirmingConnectorSave = false

    var body: some View {
        ZStack(alignment: .top) {
            MapView()
                .ignoresSafeArea()

            // Planner chrome — hidden while navigating so the HUD owns the screen.
            if !nav.isNavigating {
                plannerChrome
            }

            if nav.isNavigating {
                NavigationHUD { ride in
                    savedRide = ride
                    showRideSaved = ride != nil
                }
            }

            if showNoStreet {
                Label("No street here — long-press right on a street to rate it.", systemImage: "mappin.slash")
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
                    .padding(.top, 120)
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .sheet(isPresented: $showRideSaved) {
            if let ride = savedRide {
                RideSavedSheet(ride: ride)
                    .presentationDetents([.medium])
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
        .sheet(isPresented: $showHistory) {
            RideHistoryView()
        }
        .sheet(isPresented: $showRatings) {
            StreetRatingsView()
        }
        .sheet(isPresented: $showConnectors) {
            ConnectorsView()
        }
        // Tapped a built-but-unpublished "supplement" lane → "learn more about
        // this network" panel (build note + PBOT source link). Mirrors the web.
        .sheet(item: Binding(
            get: { store.selectedSupplement },
            set: { store.selectedSupplement = $0 }
        )) { info in
            SupplementInfoSheet(info: info)
                .presentationDetents([.height(260), .medium])
        }
        // Tap-to-rate: a long-press resolved a street → offer the four ratings.
        .confirmationDialog(
            store.pendingRatingStreet ?? "",
            isPresented: Binding(
                get: { store.pendingRatingStreet != nil },
                set: { if !$0 { store.pendingRatingStreet = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let street = store.pendingRatingStreet {
                ForEach(StreetRating.allCases) { rating in
                    Button(rating.label) {
                        StreetRatings.set(rating, for: street)
                        store.pendingRatingStreet = nil
                    }
                }
                if StreetRatings.rating(for: street) != nil {
                    Button("Clear rating", role: .destructive) {
                        StreetRatings.remove(street)
                        store.pendingRatingStreet = nil
                    }
                }
                Button("Cancel", role: .cancel) { store.pendingRatingStreet = nil }
            }
        } message: {
            Text("Rate this street — it recolors every route you plan.")
        }
        // Confirm which roads a tap-built fix links before saving it.
        .alert("Save this fix?", isPresented: $confirmingConnectorSave) {
            Button("Save") { store.saveConnector() }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Links \(linkLabel(store.connectorLinkStart)) ↔ \(linkLabel(store.connectorLinkEnd)). It'll reroute trips that pass near both ends.")
        }
        .onChange(of: store.noStreetTick) { _, _ in
            withAnimation { showNoStreet = true }
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) {
                withAnimation { showNoStreet = false }
            }
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
            case "nav":
                // Seed a route then launch straight into navigation (no touch
                // injection in the sim). Pair with a --gpx ride playback.
                await store.runDemoSnap()
                nav.start()
            default: break
            }
            #endif
        }
    }

    /// Everything shown in planning mode (hidden while navigating).
    @ViewBuilder
    private var plannerChrome: some View {
        HStack(alignment: .top, spacing: 8) {
            helpButton
                .padding(.leading, 12)
                .padding(.top, 8)
            historyButton
                .padding(.top, 8)
            ratingsButton
                .padding(.top, 8)
            connectorsButton
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
            // Corridor pick/confirm sits just above the controls — in the thumb
            // zone — since "Route through here" is a commit action, not passive
            // status (top is a reach + far from where the eye is).
            corridorBanner
            connectorBanner
            // The connector banner carries its own controls (and the map tap is
            // claimed for node-dropping), so hide the planner bar while building one
            // — its "tap to set start" hint would otherwise mislead.
            if !store.isConnectorDrawMode {
                ControlsBar(showSearch: $showSearch, showDirections: $showDirections)
            }
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

    /// Connector-build pick banner — the analog of `corridorBanner` for tap-to-add
    /// fixes. Walks: tap start → tap end (+ any midpoints) → confirm the resolved
    /// link roads → save. Sits in the thumb zone; reading the state here also keeps
    /// the MapView's node/draft overlays in sync (its updateUIView fires on render).
    @ViewBuilder
    private var connectorBanner: some View {
        if store.isConnectorDrawMode {
            let count = store.connectorPoints.count
            VStack(spacing: 10) {
                if count >= 2 {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Links")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        Text("\(linkLabel(store.connectorLinkStart)) ↔ \(linkLabel(store.connectorLinkEnd))")
                            .font(.subheadline.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 12) {
                        Button {
                            confirmingConnectorSave = true
                        } label: {
                            Text("Save fix")
                                .font(.subheadline.weight(.semibold))
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 10)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.teal)
                        Button { store.undoConnectorPoint() } label: {
                            Image(systemName: "arrow.uturn.backward")
                                .font(.subheadline.weight(.semibold))
                                .padding(.vertical, 10)
                                .padding(.horizontal, 14)
                        }
                        .buttonStyle(.bordered)
                        Button { store.exitConnectorMode() } label: {
                            Text("Cancel")
                                .font(.subheadline.weight(.medium))
                                .padding(.vertical, 10)
                                .padding(.horizontal, 12)
                        }
                        .buttonStyle(.bordered)
                    }
                } else {
                    Text(count == 0
                        ? "Tap the map to start a fix — drop a point at **each end** of the missing link."
                        : "Now tap the **other end** (and any points in between).")
                        .font(.subheadline.weight(.medium))
                        .frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 12) {
                        if count == 1 {
                            Button { store.undoConnectorPoint() } label: {
                                Label("Undo", systemImage: "arrow.uturn.backward")
                                    .font(.subheadline.weight(.medium))
                                    .padding(.vertical, 10)
                                    .padding(.horizontal, 14)
                            }
                            .buttonStyle(.bordered)
                        }
                        Button { store.exitConnectorMode() } label: {
                            Text("Cancel")
                                .font(.subheadline.weight(.medium))
                                .padding(.vertical, 10)
                                .padding(.horizontal, 16)
                        }
                        .buttonStyle(.bordered)
                        Spacer()
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(.horizontal, 16)
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    /// Display name for a resolved link end, or a graceful placeholder when the
    /// tapped node didn't land near any named street.
    private func linkLabel(_ name: String?) -> String {
        name ?? "an unnamed spot"
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

    /// Opens "My street ratings" (personal global per-street opinions). A small
    /// emerald dot marks that the score is personalized when any rating exists.
    private var ratingsButton: some View {
        Button {
            showRatings = true
        } label: {
            Image(systemName: "slider.horizontal.3")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.tint)
                .frame(width: 40, height: 40)
                .background(.regularMaterial, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if StreetRatings.hasRatings {
                        Circle()
                            .fill(Color.green)
                            .frame(width: 10, height: 10)
                            .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 1.5))
                            .offset(x: 1, y: -1)
                    }
                }
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("My street ratings")
    }

    /// Opens "My fixes" (drawn connectors). A small teal dot marks that the rider
    /// has personal fixes saved. The 🔧 wrench mirrors the web connectors entry.
    private var connectorsButton: some View {
        Button {
            showConnectors = true
        } label: {
            Image(systemName: "wrench.and.screwdriver")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.tint)
                .frame(width: 40, height: 40)
                .background(.regularMaterial, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if Connectors.hasConnectors {
                        Circle()
                            .fill(Color.teal)
                            .frame(width: 10, height: 10)
                            .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 1.5))
                            .offset(x: 1, y: -1)
                    }
                }
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("My fixes")
    }

    /// Opens the saved-rides history (distance / time / greenway %).
    private var historyButton: some View {
        Button {
            showHistory = true
        } label: {
            Image(systemName: "bicycle")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(.tint)
                .frame(width: 40, height: 40)
                .background(.regularMaterial, in: Circle())
                .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Your rides")
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

/// "Learn more about this network" panel for a tapped built-but-unpublished
/// supplement lane. Shows the build note + a tappable PBOT source link — the
/// native analog of the web `showSupplementPopup`.
private struct SupplementInfoSheet: View {
    let info: SupplementInfo
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top) {
                Label("Recently built — not yet on PBOT's map", systemImage: "hammer.fill")
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }

            if !info.name.isEmpty {
                Text(info.name)
                    .font(.subheadline.weight(.semibold))
            }

            if !info.buildNote.isEmpty {
                Text(info.buildNote)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let url = sourceURL {
                Link(destination: url) {
                    Label("PBOT project page", systemImage: "arrow.up.right.square")
                        .font(.subheadline.weight(.medium))
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
    }

    /// Only surface the link for a well-formed http(s) URL (matches the web guard).
    private var sourceURL: URL? {
        guard info.sourceURL.hasPrefix("http://") || info.sourceURL.hasPrefix("https://") else {
            return nil
        }
        return URL(string: info.sourceURL)
    }
}
