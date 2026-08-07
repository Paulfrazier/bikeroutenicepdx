import Foundation

/// Credits for the bundled bike-network data, read from bike-network.manifest.json.
///
/// The app previously credited nothing at all — not OSM, not PBOT — which OSM's
/// ODbL already required and which App Store review flags. Metro's RLIS license
/// goes further: it requires its attribution string verbatim AND the date the
/// data was received, so that date is read from the manifest the exporter writes
/// (`fetchedAt`) rather than hardcoded here, where it would go stale on the next
/// export.
///
/// Mirrors web/src/dataAttribution.ts.
struct DataAttribution: Decodable, Identifiable {
    let id: String
    let attribution: String
    let attributionUrl: String
    let fetchedAt: String

    /// "© Oregon Metro (2026-08-06)"
    var display: String {
        fetchedAt.isEmpty ? attribution : "\(attribution) (\(fetchedAt))"
    }

    var url: URL? { URL(string: attributionUrl) }
}

enum DataAttributionLoader {
    /// Bundled manifest entries, or an empty list if the manifest is missing or
    /// malformed — credits must never be the thing that crashes the app.
    static func load() -> [DataAttribution] {
        guard
            let url = Bundle.main.url(forResource: "bike-network.manifest", withExtension: "json"),
            let data = try? Data(contentsOf: url),
            let entries = try? JSONDecoder().decode([DataAttribution].self, from: data)
        else {
            return []
        }
        return entries.filter { !$0.attribution.isEmpty }
    }
}
