import SwiftUI

/// App settings sheet. Currently the routing-engine toggle (Self-build ↔ Prod).
/// Self-build is the default (door-zone avoidance + PBOT quiet streets + new
/// 2024–26 lanes prod can't see); Prod (stock brouter.de) stays here for
/// comparison/testing. Mirrors the web Settings panel. Changing the engine
/// re-routes the current route (RouteStore re-routes in its didSet).
struct SettingsView: View {
    @Environment(RouteStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var favoritesOpen = false

    var body: some View {
        @Bindable var store = store
        NavigationStack {
            List {
                Section {
                    Button {
                        favoritesOpen = true
                    } label: {
                        HStack {
                            Label("Saved places", systemImage: "star")
                            Spacer()
                            Text("\(Favorites.list().count)")
                                .foregroundStyle(.secondary)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                    }
                    .tint(.primary)
                } footer: {
                    Text("Places you've starred. They appear at the top of every search.")
                }

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

                Section {
                    Link("OpenStreetMap (ODbL)", destination: URL(string: "https://openstreetmap.org")!)
                    ForEach(attributions) { entry in
                        if let url = entry.url {
                            Link(entry.display, destination: url)
                        } else {
                            Text(entry.display)
                        }
                    }
                } header: {
                    Text("Data sources")
                } footer: {
                    Text("Routing runs on OpenStreetMap. Bike facilities come from the agencies above.")
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .sheet(isPresented: $favoritesOpen) {
                FavoritesView()
            }
        }
    }

    /// Bundled data credits (PBOT, Metro RLIS, …). Read once — the manifest is
    /// a static bundle resource, so there's nothing to refresh.
    private var attributions: [DataAttribution] { DataAttributionLoader.load() }

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
