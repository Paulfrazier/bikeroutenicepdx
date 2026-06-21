import SwiftUI

/// Shown right after a ride ends — a quick summary with the headline greenway %.
struct RideSavedSheet: View {
    let ride: Ride
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 20) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 44))
                .foregroundStyle(.green)
            Text("Ride saved")
                .font(.title2.weight(.bold))

            HStack(spacing: 28) {
                metric(ride.distanceLabel, "distance")
                metric(ride.durationLabel, "time")
                metric("\(Int((ride.greenwayShare * 100).rounded()))%", "greenways")
            }

            ShareLink(item: ride.gpx(), preview: SharePreview("Ride \(ride.date.formatted(date: .abbreviated, time: .shortened))")) {
                Label("Export GPX", systemImage: "square.and.arrow.up")
                    .font(.subheadline.weight(.medium))
            }
            .buttonStyle(.bordered)

            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(.green)
        }
        .padding(28)
    }

    private func metric(_ value: String, _ label: String) -> some View {
        VStack(spacing: 3) {
            Text(value).font(.title3.weight(.bold)).monospacedDigit()
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
    }
}

/// Past rides, newest first, with the greenway share front and center.
struct RideHistoryView: View {
    @State private var store = RideStore.shared
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.rides.isEmpty {
                    ContentUnavailableView(
                        "No rides yet",
                        systemImage: "bicycle",
                        description: Text("Navigate a route and your ride is saved here with its greenway share.")
                    )
                } else {
                    List {
                        ForEach(store.rides) { ride in
                            row(ride)
                        }
                        .onDelete { idx in
                            idx.map { store.rides[$0] }.forEach(store.delete)
                        }
                    }
                    .listStyle(.plain)
                }
            }
            .navigationTitle("Your rides")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func row(_ ride: Ride) -> some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ride.date.formatted(date: .abbreviated, time: .shortened))
                    .font(.subheadline.weight(.semibold))
                HStack(spacing: 10) {
                    Label(ride.distanceLabel, systemImage: "bicycle").labelStyle(.titleAndIcon)
                    Label(ride.durationLabel, systemImage: "clock")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Spacer()
            Label("\(Int((ride.greenwayShare * 100).rounded()))%", systemImage: "leaf.fill")
                .labelStyle(.titleAndIcon)
                .font(.headline)
                .foregroundStyle(.green)
        }
        .padding(.vertical, 4)
    }
}
