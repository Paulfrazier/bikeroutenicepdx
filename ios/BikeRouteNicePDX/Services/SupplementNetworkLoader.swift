import MapKit

/// Tappable metadata for one built-but-unpublished "supplement" lane segment.
/// Holds the SAME `MKPolyline` instance that lives inside the rendered
/// `BikeMultiPolyline` overlay (referenced by identity), so a screen-space tap
/// can be matched back to its build note + source link. We DON'T subclass
/// MKPolyline (it's a class cluster — subclassing breaks); the metadata rides
/// alongside in this parallel list instead.
struct SupplementLine {
    let polyline: MKPolyline
    let name: String
    let buildNote: String
    let sourceURL: String
}

/// The reader-facing payload shown in the "learn more about this network" panel
/// when a supplement lane is tapped. Identifiable so RootView can drive a
/// `.sheet(item:)` from it.
struct SupplementInfo: Identifiable, Equatable {
    let id = UUID()
    let name: String
    let buildNote: String
    let sourceURL: String
}
