import Foundation

/// Drives the bottom controls and map interaction state.
enum RoutePhase: Equatable {
    case idle          // no pins yet
    case settingStart  // start unset
    case settingEnd    // start set, end unset
    case readyToDraw   // both pins set, not drawing
    case drawing       // finger-draw active
    case snapping      // waiting on /match
    case routed        // snapped route shown
    case failed(String)
}
