import MapKit

/// Loads the bundled bike-network.geojson (the metro bike network) for the map
/// overlay: one MKMultiPolyline per facility class, sorted so higher-quality
/// facilities render on top, plus the built-but-unpublished "supplement" lanes
/// (PBOT 2024-2026) as their own overlays with tappable metadata.
///
/// Split in two so launch never blocks on the 8.7 MB file:
///   - `parse()` does ONE JSONSerialization pass into plain coordinate arrays.
///     It's Sendable, nonisolated work — run it off the main thread.
///   - `overlays(from:)` wraps those arrays in MapKit objects on the main actor,
///     which is cheap next to the parse.
/// (It used to run on the main thread inside makeUIView, parsing the file four
/// times across two loaders plus a JSON parse of every feature's properties —
/// ~650 ms of frozen launch on an M-series Mac, more on a phone.)
///
/// JSONSerialization rather than MKGeoJSONDecoder: the latter decodes a
/// FeatureCollection atomically, so a single feature with degenerate
/// coordinates would throw and blank the entire overlay. Here a short line is
/// simply skipped.
enum BikeNetworkLoader {
    struct ParsedNetwork: Sendable {
        struct Supplement: Sendable {
            let cls: BikeClass
            let coords: [CLLocationCoordinate2D]
            let name: String
            let buildNote: String
            let sourceURL: String
        }

        /// Published-network lines bucketed by display class.
        var byClass: [BikeClass: [[CLLocationCoordinate2D]]] = [:]
        /// Supplement lines, kept separate so they can be tapped for a build note.
        var supplements: [Supplement] = []
    }

    struct Overlays {
        let network: [BikeMultiPolyline]
        let supplement: [BikeMultiPolyline]
        /// Same MKPolyline instances as inside `supplement`, for tap hit-testing.
        let supplementHits: [SupplementLine]
    }

    static func parse() -> ParsedNetwork {
        var out = ParsedNetwork()
        guard
            let url = Bundle.main.url(forResource: "bike-network", withExtension: "geojson"),
            let data = try? Data(contentsOf: url),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let features = root["features"] as? [[String: Any]]
        else {
            return out
        }

        for feature in features {
            guard
                let geometry = feature["geometry"] as? [String: Any],
                let type = geometry["type"] as? String
            else { continue }

            let lines: [[[Double]]]
            switch type {
            case "LineString":
                guard let line = geometry["coordinates"] as? [[Double]] else { continue }
                lines = [line]
            case "MultiLineString":
                guard let multi = geometry["coordinates"] as? [[[Double]]] else { continue }
                lines = multi
            default:
                continue
            }

            let props = feature["properties"] as? [String: Any] ?? [:]
            let cls = bikeClass(props)
            let supplement = isSupplement(props)

            for line in lines where line.count >= 2 {
                let coords = line.compactMap { p in
                    p.count >= 2 ? CLLocationCoordinate2D(latitude: p[1], longitude: p[0]) : nil
                }
                guard coords.count >= 2 else { continue }
                if supplement {
                    out.supplements.append(.init(
                        cls: cls,
                        coords: coords,
                        name: props["name"] as? String ?? "",
                        buildNote: props["build_note"] as? String ?? "",
                        sourceURL: props["source_url"] as? String ?? ""
                    ))
                } else {
                    out.byClass[cls, default: []].append(coords)
                }
            }
        }
        return out
    }

    @MainActor
    static func overlays(from parsed: ParsedNetwork) -> Overlays {
        var supplementByClass: [BikeClass: [MKPolyline]] = [:]
        var hits: [SupplementLine] = []
        for s in parsed.supplements {
            let line = MKPolyline(coordinates: s.coords, count: s.coords.count)
            supplementByClass[s.cls, default: []].append(line)
            hits.append(SupplementLine(
                polyline: line, name: s.name, buildNote: s.buildNote, sourceURL: s.sourceURL
            ))
        }
        let network = bucketed(parsed.byClass.mapValues { lines in
            lines.map { MKPolyline(coordinates: $0, count: $0.count) }
        })
        return Overlays(
            network: network,
            supplement: bucketed(supplementByClass),
            supplementHits: hits
        )
    }

    /// One MKMultiPolyline per class, low-priority first so protected / greenway
    /// lines sit on top of plain lanes.
    @MainActor
    private static func bucketed(_ byClass: [BikeClass: [MKPolyline]]) -> [BikeMultiPolyline] {
        BikeClass.allCases
            .sorted { $0.zPriority < $1.zPriority }
            .compactMap { cls in
                guard let lines = byClass[cls], !lines.isEmpty else { return nil }
                let overlay = BikeMultiPolyline(lines)
                overlay.bikeClass = cls
                return overlay
            }
    }

    /// Display class from `rclass` (preferred — fast unprotected lanes are baked
    /// to "busy" so they render red dashed without a runtime speed lookup), else
    /// `class`, else `.lane`.
    private static func bikeClass(_ props: [String: Any]) -> BikeClass {
        let raw = (props["rclass"] as? String) ?? (props["class"] as? String) ?? ""
        return BikeClass(rawValue: raw) ?? .lane
    }

    /// True for a built-but-unpublished "supplement" feature. The flag may decode
    /// as a Bool (`true`) or, defensively, as a numeric `1`.
    private static func isSupplement(_ props: [String: Any]) -> Bool {
        if let flag = props["supplement"] as? Bool { return flag }
        if let n = props["supplement"] as? NSNumber { return n.intValue == 1 }
        return false
    }
}
