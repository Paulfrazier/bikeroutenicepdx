import Foundation

/// The user's personal, global per-street opinions — the iOS mirror of the web
/// `streetRatings.ts`. A street rated here overrides the data-derived class the
/// friendliness classifier would otherwise assign, so it recolors the route and
/// (for `avoid`) moves the comfort-coverage % everywhere that street appears.
///
/// MUST stay in lockstep with web `web/src/streetRatings.ts` — same rating names,
/// same rating→RouteClass mapping, same `normalize(_:)` — so a street rated on one
/// surface classifies identically on the other.

/// The four personal ratings. Map onto EXISTING RouteClass values so nothing
/// downstream changes. (KEEP IN SYNC WITH web RATING_TO_CLASS.)
enum StreetRating: String, CaseIterable, Identifiable {
    case great
    case good
    case bad
    case avoid

    var id: String { rawValue }

    /// Rating → RouteClass. Only `avoid` (→ .busy) is excluded from coverage.
    var routeClass: RouteClass {
        switch self {
        case .great: return .protected
        case .good: return .greenway
        case .bad: return .shared
        case .avoid: return .busy
        }
    }

    /// Human label for the manage UI / quick-rate sheet. (KEEP IN SYNC with web.)
    var label: String {
        switch self {
        case .great: return "Great"
        case .good: return "Good"
        case .bad: return "Meh"
        case .avoid: return "Avoid"
        }
    }
}

enum StreetRatings {
    static let storageKey = "bikenice.streetRatings"

    /// A leading Portland directional — stripped so a street is ONE global
    /// opinion across quadrants. Both abbreviated (PBOT "SE 17TH AVE") and
    /// spelled-out (OSM "Southeast 17th Avenue") forms are listed so the two data
    /// sources converge. (KEEP IN SYNC with web LEAD_DIRECTIONALS.)
    private static let leadDirectionals: Set<String> = [
        "N", "NE", "E", "SE", "S", "SW", "W", "NW",
        "NORTH", "NORTHEAST", "EAST", "SOUTHEAST",
        "SOUTH", "SOUTHWEST", "WEST", "NORTHWEST",
    ]

    /// Street-type suffix → canonical abbreviation, so "AVE" and "Avenue" land on
    /// the same key. (KEEP IN SYNC with web SUFFIX_CANON.)
    private static let suffixCanon: [String: String] = [
        "STREET": "ST", "ST": "ST",
        "AVENUE": "AVE", "AVE": "AVE", "AV": "AVE",
        "BOULEVARD": "BLVD", "BLVD": "BLVD",
        "DRIVE": "DR", "DR": "DR",
        "ROAD": "RD", "RD": "RD",
        "PARKWAY": "PKWY", "PKWY": "PKWY", "PKY": "PKWY",
        "PLACE": "PL", "PL": "PL",
        "COURT": "CT", "CT": "CT",
        "LANE": "LN", "LN": "LN",
        "TERRACE": "TER", "TER": "TER", "TERR": "TER",
        "HIGHWAY": "HWY", "HWY": "HWY",
        "CIRCLE": "CIR", "CIR": "CIR",
        "TRAIL": "TRL", "TRL": "TRL",
        "WAY": "WAY", "LOOP": "LOOP",
    ]

    /// Normalize a raw street name to its global key: uppercase, drop punctuation,
    /// strip a leading directional (full or abbreviated), and canonicalize the
    /// street-type suffix — so abbreviated PBOT names and spelled-out OSM names for
    /// the SAME street collapse to one key. Numbered cross-streets in different
    /// quadrants merge by design (the rating is global by name).
    ///
    /// MUST match web normalizeStreetName() exactly.
    static func normalize(_ raw: String) -> String {
        let cleaned = raw.uppercased()
            .replacingOccurrences(of: ".", with: "")
            .replacingOccurrences(of: ",", with: "")
        var tokens = cleaned.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !tokens.isEmpty else { return "" }
        // Strip a leading directional only when something follows it.
        if tokens.count > 1, leadDirectionals.contains(tokens[0]) {
            tokens.removeFirst()
        }
        // Canonicalize the suffix (last token).
        let last = tokens.count - 1
        if let canon = suffixCanon[tokens[last]] { tokens[last] = canon }
        return tokens.joined(separator: " ")
    }

    /// All ratings as normalized-name → rating.
    static func all() -> [String: StreetRating] {
        guard let raw = UserDefaults.standard.dictionary(forKey: storageKey) as? [String: String] else {
            return [:]
        }
        var out: [String: StreetRating] = [:]
        for (k, v) in raw {
            if let r = StreetRating(rawValue: v) { out[normalize(k)] = r }
        }
        return out
    }

    /// The class-override map the classifier consults: normalized name → RouteClass.
    static func overrides() -> [String: RouteClass] {
        all().mapValues { $0.routeClass }
    }

    /// Sorted rows for the manage UI.
    static func list() -> [(name: String, rating: StreetRating)] {
        all().map { (name: $0.key, rating: $0.value) }.sorted { $0.name < $1.name }
    }

    static func rating(for name: String) -> StreetRating? { all()[normalize(name)] }

    static var hasRatings: Bool { !all().isEmpty }

    /// Set (or replace) the rating for a street. `name` may be raw — it's normalized.
    static func set(_ rating: StreetRating, for name: String) {
        let key = normalize(name)
        guard !key.isEmpty else { return }
        var dict = (UserDefaults.standard.dictionary(forKey: storageKey) as? [String: String]) ?? [:]
        dict[key] = rating.rawValue
        UserDefaults.standard.set(dict, forKey: storageKey)
        NotificationCenter.default.post(name: .streetRatingsChanged, object: nil)
    }

    /// Remove a street's rating (revert it to the data-derived class).
    static func remove(_ name: String) {
        let key = normalize(name)
        var dict = (UserDefaults.standard.dictionary(forKey: storageKey) as? [String: String]) ?? [:]
        guard dict[key] != nil else { return }
        dict[key] = nil
        UserDefaults.standard.set(dict, forKey: storageKey)
        NotificationCenter.default.post(name: .streetRatingsChanged, object: nil)
    }
}

extension Notification.Name {
    /// Posted whenever the user's street ratings change (re-classify the route).
    static let streetRatingsChanged = Notification.Name("bikenice.streetRatingsChanged")
}
