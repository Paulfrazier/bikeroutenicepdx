import SwiftUI

/// App settings sheet. Currently the routing-engine toggle (Self-build ↔ Prod).
/// Self-build is the default (door-zone avoidance + PBOT quiet streets + new
/// 2024–26 lanes prod can't see); Prod (stock brouter.de) stays here for
/// comparison/testing. Mirrors the web Settings panel. Changing the engine
/// re-routes the current route (RouteStore re-routes in its didSet).
struct SettingsView: View {
    @Environment(RouteStore.self) private var store
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                Section {
                    Picker("Engine", selection: $store.routingEngine) {
                        ForEach(RoutingEngine.allCases) { engine in
                            Text(engine.label).tag(engine)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("Routing engine")
                } footer: {
                    Text(engineHint)
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    /// One-line explanation of the selected engine.
    private var engineHint: String {
        switch store.routingEngine {
        case .selfbuild:
            return "Self-built tiles — avoids door-zone lanes, knows new bike lanes (default)."
        case .prod:
            return "Stock brouter.de tiles — for comparison/testing."
        }
    }
}
