import SwiftUI

/// Reopenable cheat sheet of every map gesture (anchors + draw modes), grouped
/// by mode. Mirrors the web `GestureGuide`. Presented as a sheet from the "?"
/// button; offers a "Replay the tour" action at the bottom.
struct GestureGuideView: View {
    /// Dismiss the guide.
    let onClose: () -> Void
    /// Close the guide and relaunch the onboarding tour.
    let onReplayTour: () -> Void

    private struct Gesture: Identifiable {
        let id = UUID()
        let action: String
        let result: String
    }
    private struct Group: Identifiable {
        let id = UUID()
        let icon: String       // SF Symbol name
        let tint: Color
        let mode: String
        let hint: String?
        let gestures: [Gesture]
    }

    private let groups: [Group] = [
        Group(icon: "mappin.and.ellipse", tint: .red, mode: "Set points", hint: nil, gestures: [
            Gesture(action: "Tap the map", result: "Drops your start, then your destination"),
            Gesture(action: "Tap a pin chip", result: "Search for an address or place"),
            Gesture(action: "Use my location", result: "Sets the start to where you are"),
            Gesture(action: "Trash button", result: "Clears everything and starts over"),
        ]),
        Group(icon: "mappin.and.ellipse", tint: .green, mode: "Build — guided draw", hint: "Tap “Edit”, then “Build”", gestures: [
            Gesture(action: "Tap the map", result: "Adds a waypoint; the route builds piece by piece through each one"),
            Gesture(action: "Tap a waypoint", result: "Removes it"),
            Gesture(action: "Undo / Clear", result: "Drops the last waypoint, or all of them"),
            Gesture(action: "Turn off “Snap to roads”", result: "Drag to sketch a freehand line on the map (not routed)"),
        ]),
        Group(icon: "hand.draw.fill", tint: .blue, mode: "Edit route — anchors", hint: "Tap “Edit” first", gestures: [
            Gesture(action: "Drag the route", result: "Reshapes it, re-snapping to the nearest roads"),
            Gesture(action: "Long-press the line", result: "Drops a precise anchor exactly there (no snap)"),
            Gesture(action: "Tap a dot", result: "Removes that waypoint"),
            Gesture(action: "Long-press a dot", result: "Toggles it between snap and precise"),
        ]),
        Group(icon: "scribble.variable", tint: .purple, mode: "Draw", hint: "Tap “Draw” first", gestures: [
            Gesture(action: "Drag one finger", result: "Traces a stretch, spliced into the route as-drawn"),
        ]),
        Group(icon: "point.topleft.down.to.point.bottomright.curvepath", tint: .teal, mode: "Route through a section", hint: "Tap it first", gestures: [
            Gesture(action: "Tap start, then end", result: "Reroutes down that whole stretch of street"),
        ]),
    ]

    var body: some View {
        NavigationStack {
            List {
                ForEach(groups) { group in
                    Section {
                        ForEach(group.gestures) { g in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(g.action)
                                    .font(.subheadline.weight(.semibold))
                                    .foregroundStyle(.green)
                                Text(g.result)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                    } header: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 8) {
                                Image(systemName: group.icon)
                                    .foregroundStyle(group.tint)
                                Text(group.mode)
                                    .foregroundStyle(.primary)
                            }
                            .font(.headline)
                            .textCase(nil)
                            if let hint = group.hint {
                                Text(hint)
                                    .font(.caption.italic())
                                    .textCase(nil)
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.top, 4)
                    }
                }

                Section {
                    Button {
                        onReplayTour()
                    } label: {
                        Label("Replay the tour", systemImage: "play.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .tint(.green)
                }
            }
            .navigationTitle("Gesture guide")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done", action: onClose)
                }
            }
        }
    }
}
