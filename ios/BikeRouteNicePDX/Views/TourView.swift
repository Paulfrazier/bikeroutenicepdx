import SwiftUI

/// First-run / replayable onboarding walkthrough. Slide-based (paged TabView)
/// so it's robust and mirrors the web `Tour`. Auto-shown the first launch via
/// the `tourSeen` AppStorage flag in `RootView`; reopenable from the gesture
/// guide's "Replay the tour" button.
struct TourView: View {
    /// Called when the user finishes or skips — the host dismisses + marks seen.
    let onClose: () -> Void

    @State private var index = 0

    private struct Slide: Identifiable {
        let id = UUID()
        let icon: String       // SF Symbol name
        let tint: Color
        let title: String
        let body: String
    }

    private let slides: [Slide] = [
        Slide(
            icon: "bicycle",
            tint: .green,
            title: "Welcome to BikeRoute PDX",
            body: "Find calm, bike-friendly routes across Portland — built on the city's neighborhood greenway network. Here's how to drive it."
        ),
        Slide(
            icon: "mappin.and.ellipse",
            tint: .red,
            title: "Set your start & end",
            body: "Tap the map to drop your start, then tap again for your destination. Or tap a pin chip to search an address, or use “Use my location.”"
        ),
        Slide(
            icon: "map.fill",
            tint: .green,
            title: "Read the route",
            body: "The line is colored by how bike-friendly each stretch is — green greenways down to red arterials. The “% comfortable” shows how much of the ride is calm. Toggle Comfort vs. Fast any time."
        ),
        Slide(
            icon: "hand.draw.fill",
            tint: .blue,
            title: "Reshape by dragging",
            body: "Tap Edit, then grab the route and drag it onto a street you'd rather take — it re-snaps to roads and re-routes. Tap a dot to remove it."
        ),
        Slide(
            icon: "pin.fill",
            tint: .orange,
            title: "Precise anchors",
            body: "Want the route through an exact spot? Long-press the line to drop a precise anchor — pinned exactly where you put it, no snapping. Long-press a dot to flip it between snap and precise."
        ),
        Slide(
            icon: "scribble.variable",
            tint: .purple,
            title: "Draw your own stretch",
            body: "Tap Draw, then drag one finger from start to finish to trace a path by hand. It's spliced into the route exactly as you drew it."
        ),
        Slide(
            icon: "point.topleft.down.to.point.bottomright.curvepath",
            tint: .teal,
            title: "Route through a section",
            body: "Tap “Route through a section,” then tap a street's start and end. The route is rerouted to flow down that whole stretch."
        ),
        Slide(
            icon: "checkmark.circle.fill",
            tint: .green,
            title: "You're set",
            body: "That's everything. Need a refresher later? Tap the ? button any time for the gesture guide."
        ),
    ]

    private var isLast: Bool { index == slides.count - 1 }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button("Skip", action: onClose)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.trailing, 20)
                    .padding(.top, 16)
            }

            TabView(selection: $index) {
                ForEach(Array(slides.enumerated()), id: \.element.id) { i, slide in
                    VStack(spacing: 16) {
                        Spacer()
                        Image(systemName: slide.icon)
                            .font(.system(size: 60))
                            .foregroundStyle(slide.tint)
                            .frame(height: 72)
                        Text(slide.title)
                            .font(.title2.weight(.bold))
                            .multilineTextAlignment(.center)
                        Text(slide.body)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 28)
                        Spacer()
                    }
                    .tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))

            HStack {
                Button("Back") {
                    withAnimation { index = max(0, index - 1) }
                }
                .disabled(index == 0)
                .opacity(index == 0 ? 0.4 : 1)

                Spacer()
                Text("\(index + 1) / \(slides.count)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                Spacer()

                Button(isLast ? "Done" : "Next") {
                    if isLast {
                        onClose()
                    } else {
                        withAnimation { index += 1 }
                    }
                }
                .font(.headline)
            }
            .padding(.horizontal, 28)
            .padding(.bottom, 24)
        }
        .tint(.green)
    }
}
