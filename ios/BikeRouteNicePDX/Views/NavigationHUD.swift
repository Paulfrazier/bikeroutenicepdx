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
            if nav.arrived {
                arrivalCard
            } else {
                maneuverBanner
            }
            Spacer()
            bottomPanel
        }
        .animation(.easeInOut(duration: 0.2), value: nav.nextStep?.instruction)
        .animation(.easeInOut(duration: 0.2), value: nav.arrived)
    }

    // MARK: - Top: next maneuver

    private var maneuverBanner: some View {
        HStack(spacing: 16) {
            Image(systemName: ManeuverStyle.symbol(nav.nextStep?.maneuver_type ?? "arrow.up"))
                .font(.system(size: 34, weight: .bold))
                .foregroundStyle(.white)
                .frame(width: 52)

            VStack(alignment: .leading, spacing: 2) {
                Text(nav.isRerouting ? "Rerouting…" : nav.distanceToNextLabel)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(.white)
                Text(nav.nextStep?.instruction ?? "Continue on the route")
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.white.opacity(0.9))
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
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

    // MARK: - Bottom: trip stats + controls

    private var bottomPanel: some View {
        VStack(spacing: 14) {
            HStack {
                stat(nav.etaLabel, "ETA")
                Spacer()
                stat(nav.distanceRemainingLabel, "to go")
                Spacer()
                toggles
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
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .shadow(color: .black.opacity(0.15), radius: 12, y: 4)
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
