import SwiftUI

/// Bottom control card. Phase-driven: pin chips on top, a context action below.
struct ControlsBar: View {
    @Environment(RouteStore.self) private var store
    @Binding var showSearch: Bool

    var body: some View {
        VStack(spacing: 12) {
            pinChips
            actionArea
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
    }

    // MARK: - Pin chips

    private var pinChips: some View {
        HStack(spacing: 10) {
            pinChip(
                title: store.start?.label ?? "Set start",
                isSet: store.start != nil,
                color: .green,
                icon: "figure.outdoor.cycle"
            )
            pinChip(
                title: store.end?.label ?? "Set destination",
                isSet: store.end != nil,
                color: .red,
                icon: "flag.checkered"
            )
        }
    }

    private func pinChip(title: String, isSet: Bool, color: Color, icon: String) -> some View {
        Button {
            showSearch = true
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .foregroundStyle(isSet ? color : .secondary)
                Text(title)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .foregroundStyle(isSet ? .primary : .secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .padding(.horizontal, 12)
            .background(
                Capsule().fill(Color.primary.opacity(0.06))
            )
            .overlay(
                Capsule().stroke(isSet ? color.opacity(0.5) : .clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Action area

    @ViewBuilder
    private var actionArea: some View {
        switch store.phase {
        case .idle, .settingStart:
            hint("Tap the map or search to drop your start pin.")
        case .settingEnd:
            hint("Now set your destination.")
        case .readyToDraw:
            HStack(spacing: 12) {
                clearAllButton
                primaryButton("Draw route", icon: "hand.draw.fill") {
                    store.enterDrawMode()
                }
            }
        case .drawing:
            HStack(spacing: 12) {
                secondaryButton("Cancel") { store.clearDraw() }
                hint("Drag one finger from start to finish.")
            }
        case .snapping:
            HStack(spacing: 10) {
                ProgressView()
                Text("Snapping to the bike network…")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        case .routed:
            VStack(spacing: 10) {
                if let snapped = store.snapped {
                    HStack {
                        Label(snapped.distanceLabel, systemImage: "bicycle")
                            .font(.headline)
                        Spacer()
                        Text(routeCaption)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 12) {
                    clearAllButton
                    primaryButton("Redraw", icon: "arrow.counterclockwise") {
                        store.clearDraw()
                    }
                }
            }
        case .failed(let message):
            VStack(spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline)
                    .foregroundStyle(.orange)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                HStack(spacing: 12) {
                    clearAllButton
                    primaryButton("Try again", icon: "hand.draw.fill") {
                        store.enterDrawMode()
                    }
                }
            }
        }
    }

    // MARK: - Reusable bits

    /// Caption under the routed distance. Reflects whether the route has been
    /// reshaped with drag-to-reshape via points.
    private var routeCaption: String {
        if store.isManuallyEdited {
            return "Reshaping…" // re-route in flight after a drag
        }
        let count = store.vias.count
        switch count {
        case 0: return "Snapped to greenways"
        case 1: return "Routed through 1 point"
        default: return "Routed through \(count) points"
        }
    }

    private func hint(_ text: String) -> some View {
        Text(text)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
    }

    private func primaryButton(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
        }
        .buttonStyle(.borderedProminent)
        .tint(.green)
    }

    private func secondaryButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.medium))
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
        }
        .buttonStyle(.bordered)
    }

    private var clearAllButton: some View {
        Button(role: .destructive) {
            store.clearAll()
        } label: {
            Image(systemName: "trash")
                .font(.headline)
                .padding(.vertical, 12)
                .padding(.horizontal, 16)
        }
        .buttonStyle(.bordered)
    }
}
