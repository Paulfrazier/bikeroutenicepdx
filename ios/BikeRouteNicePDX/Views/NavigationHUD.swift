import SwiftUI

/// The live turn-by-turn HUD, overlaid on the map while navigating. Top banner =
/// next maneuver + distance; bottom panel (thumb zone) = ETA / distance remaining
/// + controls + the big End button. The map shows through the gap between them.
struct NavigationHUD: View {
    @Environment(NavigationSession.self) private var nav

    /// Called when the rider ends navigation (so RootView can surface a saved-ride
    /// summary). Passes the finished ride, if one was recorded.
    var onEnd: (Ride?) -> Void

    var body: some View {
        VStack(spacing: 0) {
            switch nav.navPhase {
            case .arrived: arrivalCard
            case .pausedAtStop: legPauseCard
            case .guiding: maneuverBanner
            }
            Spacer()
            bottomPanel
        }
        .animation(.easeInOut(duration: 0.2), value: nav.nextStep?.instruction)
        .animation(.easeInOut(duration: 0.2), value: nav.navPhase)
    }

    // MARK: - Top: next maneuver

    /// Show the "then" preview chip once the current turn is this close (m).
    private static let thenPreviewWithinM: Double = 150

    private var maneuverBanner: some View {
        HStack(spacing: 16) {
            Image(systemName: ManeuverStyle.symbol(nav.nextStep?.maneuver_type ?? "arrow.up"))
                .font(.system(size: 44, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 60)

            VStack(alignment: .leading, spacing: 2) {
                // Sized for a handlebar-mounted phone: glanceable at speed.
                Text(nav.isRerouting ? "Rerouting…" : nav.distanceToNextLabel)
                    .font(.system(size: 44, weight: .heavy))
                    .monospacedDigit()
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .foregroundStyle(.white)
                Text(nav.nextStep?.instruction ?? "Continue on the route")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.95))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if nav.distanceToNextManeuver < Self.thenPreviewWithinM, let then = nav.followingStep {
                    HStack(spacing: 5) {
                        Text("then")
                        Image(systemName: ManeuverStyle.symbol(then.maneuver_type))
                        Text(then.street_name ?? then.instruction)
                            .lineLimit(1)
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.85))
                }
                if let pill = ManeuverStyle.pill(nav.currentStep?.bicycle_network_class) {
                    Text(pill.label)
                        .font(.caption2.weight(.bold))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background(.white.opacity(0.22), in: Capsule())
                        .foregroundStyle(.white)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(navGreen, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    // MARK: - Arrival

    private var arrivalCard: some View {
        HStack(spacing: 14) {
            Image(systemName: "flag.checkered.circle.fill")
                .font(.system(size: 34))
                .foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 2) {
                Text("You've arrived")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white)
                Text("Nice ride.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.9))
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(navGreen, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    // MARK: - Leg pause (multi-stop)

    /// Informational only — Continue / Skip live in the thumb zone below.
    private var legPauseCard: some View {
        HStack(spacing: 14) {
            Image(systemName: "mappin.circle.fill")
                .font(.system(size: 34))
                .foregroundStyle(.white)
            VStack(alignment: .leading, spacing: 2) {
                Text(nav.legLabel.map { "Arrived at \($0)" } ?? "Arrived at your stop")
                    .font(.title3.weight(.bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text(nav.resumeFailed
                    ? "Couldn't fetch the next leg. Try again when you have signal."
                    : "Take your time — guidance is paused.")
                    .font(.subheadline)
                    .foregroundStyle(.white.opacity(0.9))
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(navGreen, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: .black.opacity(0.25), radius: 12, y: 4)
        .padding(.horizontal, 12)
        .padding(.top, 8)
    }

    // MARK: - Bottom: trip stats + controls

    private var bottomPanel: some View {
        VStack(spacing: 14) {
            // Thin ridden-fraction bar.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.12))
                    Capsule()
                        .fill(navGreen)
                        .frame(width: max(4, geo.size.width * nav.progressFraction))
                }
            }
            .frame(height: 4)
            .accessibilityLabel("Route progress")
            .accessibilityValue("\(Int((nav.progressFraction * 100).rounded())) percent")

            // On a multi-stop trip the stats above describe the CURRENT leg, so
            // say which leg that is.
            if let legLabel = nav.legProgressLabel {
                HStack {
                    Text(legLabel)
                        .font(.caption.weight(.bold))
                        .padding(.horizontal, 9)
                        .padding(.vertical, 3)
                        .background(navGreen.opacity(0.15), in: Capsule())
                        .foregroundStyle(navGreen)
                    Spacer(minLength: 0)
                }
            }

            HStack {
                stat(nav.etaLabel, "ETA")
                Spacer()
                stat(nav.distanceRemainingLabel, "to go")
                Spacer()
                stat("\(nav.speedMph)", "mph")
                Spacer()
                toggles
            }
            legControls
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
    }

    /// Commit actions, kept in the thumb zone at the bottom of the screen rather
    /// than in the banner up top.
    @ViewBuilder
    private var legControls: some View {
        switch nav.navPhase {
        case .pausedAtStop:
            VStack(spacing: 10) {
                Button {
                    Task { await nav.resume() }
                } label: {
                    Text(nav.nextLegLabel.map { "Continue to \($0)" } ?? "Continue")
                        .font(.headline)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(navGreen)
                .disabled(nav.isRerouting)

                HStack(spacing: 10) {
                    Button("Skip stop") {
                        Task { await nav.skipStop() }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .disabled(nav.isRerouting)

                    Button("End trip", role: .destructive) {
                        onEnd(nav.stop())
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                }
                .font(.headline)
                .lineLimit(1)
                .buttonStyle(.bordered)
            }
        case .guiding, .arrived:
            VStack(spacing: 10) {
                // Backstop for locking up short of the stop, where the arrival
                // radius alone would never hand over a Continue button.
                if nav.showManualArrival {
                    Button {
                        nav.declareArrival()
                    } label: {
                        Text("I'm here")
                            .font(.headline)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 13)
                    }
                    .buttonStyle(.bordered)
                    .tint(navGreen)
                }
                Button(role: .destructive) {
                    onEnd(nav.stop())
                } label: {
                    Text(nav.arrived ? "Done" : "End")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                }
                .buttonStyle(.borderedProminent)
                .tint(nav.arrived ? .green : .red)
            }
        }
    }

    private var toggles: some View {
        HStack(spacing: 10) {
            iconToggle(
                on: nav.voiceEnabled,
                onSymbol: "speaker.wave.2.fill",
                offSymbol: "speaker.slash.fill"
            ) { nav.voiceEnabled.toggle() }
            iconToggle(
                on: nav.calmMode,
                onSymbol: "leaf.fill",
                offSymbol: "leaf"
            ) { nav.calmMode.toggle() }
        }
    }

    private func iconToggle(on: Bool, onSymbol: String, offSymbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: on ? onSymbol : offSymbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(on ? Color.green : .secondary)
                .frame(width: 44, height: 44)
                .background(Color.primary.opacity(0.06), in: Circle())
        }
        .buttonStyle(.plain)
    }

    private func stat(_ value: String, _ label: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(value)
                .font(.title3.weight(.bold))
                .monospacedDigit()
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var navGreen: Color { Color(red: 0.13, green: 0.55, blue: 0.30) }
}
