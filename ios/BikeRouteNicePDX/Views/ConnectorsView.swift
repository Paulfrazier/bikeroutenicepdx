import SwiftUI

/// "My fixes" — the manage sheet for the rider's personal network connectors
/// (drawn map fixes). Each connector is rendered on the map, classified as a
/// comfortable `path`, snapped to on drag, and auto-spliced into any route that
/// passes near both of its ends. From here the rider can draw a new fix, rename
/// or delete one, and submit a fix for community review.
///
/// Mirrors `StreetRatingsView.swift` (sheet + NotificationCenter refresh) and the
/// web `Connectors.tsx` panel.
struct ConnectorsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(RouteStore.self) private var store

    /// Local mirror of the store, reloaded on every mutation (and when the sheet
    /// appears) so the list reflects connectors added via the draw tool too.
    @State private var rows: [Connector] = Connectors.list()

    // Rename flow.
    @State private var renaming: Connector?
    @State private var renameText = ""

    // Submit flow — a transient confirmation/error banner.
    @State private var submittingID: String?
    @State private var submitMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if rows.isEmpty {
                    emptyState
                } else {
                    list
                }
            }
            .navigationTitle("My fixes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        addFix()
                    } label: {
                        Label("Add a fix", systemImage: "hand.tap")
                    }
                }
            }
            .alert(
                "Rename fix",
                isPresented: Binding(
                    get: { renaming != nil },
                    set: { if !$0 { renaming = nil } }
                )
            ) {
                TextField("Name", text: $renameText)
                Button("Save") {
                    if let c = renaming {
                        Connectors.rename(c.id, renameText.trimmingCharacters(in: .whitespacesAndNewlines))
                        rows = Connectors.list()
                    }
                    renaming = nil
                }
                Button("Cancel", role: .cancel) { renaming = nil }
            } message: {
                Text("Give this fix a name so you can recognize it (e.g. \"SE 16th cycletrack @ Hawthorne\").")
            }
        }
        .overlay(alignment: .bottom) {
            if let msg = submitMessage {
                Text(msg)
                    .font(.subheadline.weight(.medium))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.ultraThinMaterial, in: Capsule())
                    .shadow(color: .black.opacity(0.15), radius: 8, y: 3)
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .connectorsChanged)) { _ in
            rows = Connectors.list()
        }
        .onAppear { rows = Connectors.list() }
    }

    private var list: some View {
        List {
            Section {
                ForEach(rows) { connector in
                    HStack(spacing: 10) {
                        Image(systemName: "scribble.variable")
                            .foregroundStyle(.teal)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(connector.name?.isEmpty == false ? connector.name! : "Unnamed fix")
                                .font(.body)
                            Text("\(connector.coords.count) points")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        if submittingID == connector.id {
                            ProgressView()
                        } else {
                            rowMenu(for: connector)
                        }
                    }
                }
                .onDelete { offsets in
                    for index in offsets { Connectors.remove(rows[index].id) }
                    rows = Connectors.list()
                }
            } footer: {
                Text("Fixes are saved on this device. They recolor and reroute your trips wherever they apply. Submit one for review to share it with everyone.")
            }
        }
    }

    /// Per-row menu: rename, submit for review, or delete.
    private func rowMenu(for connector: Connector) -> some View {
        Menu {
            Button {
                renameText = connector.name ?? ""
                renaming = connector
            } label: {
                Label("Rename", systemImage: "pencil")
            }
            Button {
                submit(connector)
            } label: {
                Label("Submit for review", systemImage: "paperplane")
            }
            Divider()
            Button(role: .destructive) {
                Connectors.remove(connector.id)
                rows = Connectors.list()
            } label: {
                Label("Delete", systemImage: "trash")
            }
        } label: {
            Image(systemName: "ellipsis.circle")
                .font(.title3)
                .foregroundStyle(.secondary)
        }
    }

    /// Enter connector-build mode and dismiss so the rider can tap nodes to trace a
    /// fix on the map. No route is required.
    private func addFix() {
        store.enterConnectorMode()
        dismiss()
    }

    /// Submit a connector to the server's review queue. Shows a transient
    /// confirmation (or a graceful error — the endpoint is built in parallel).
    private func submit(_ connector: Connector) {
        submittingID = connector.id
        Task {
            let message: String
            do {
                _ = try await APIClient.submitFix(coords: connector.coords, note: connector.name)
                message = "Submitted — pending review"
            } catch {
                message = "Couldn't submit — try again later."
            }
            submittingID = nil
            withAnimation { submitMessage = message }
            try? await Task.sleep(nanoseconds: 2_600_000_000)
            withAnimation { submitMessage = nil }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 14) {
            Image(systemName: "scribble.variable")
                .font(.system(size: 44))
                .foregroundStyle(.teal)
            Text("No fixes yet")
                .font(.headline)
            Text("Tap to drop points where the router misses a connection — a cycletrack it can't see, a median crossing, a cut-through. Your fix is saved on this device, shown on the map, scored as comfortable, and spliced into routes that pass near it.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
            Button {
                addFix()
            } label: {
                Label("Add a fix", systemImage: "hand.tap")
                    .font(.headline)
                    .padding(.vertical, 10)
                    .padding(.horizontal, 18)
            }
            .buttonStyle(.borderedProminent)
            .tint(.teal)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
}
