import SwiftUI

/// Shared maneuver → SF Symbol mapping and bike-network pill palette, used by the
/// directions list, the navigation HUD, the Live Activity, and the watch app so
/// every surface shows the same icon/label for a given maneuver or infra class.
enum ManeuverStyle {
    static func symbol(_ type: String) -> String {
        switch type {
        case "start", "start_right", "start_left": return "figure.outdoor.cycle"
        case "destination", "destination_right", "destination_left": return "flag.checkered"
        case "left", "sharp_left", "exit_left", "ramp_left", "merge_left": return "arrow.turn.up.left"
        case "slight_left", "stay_left": return "arrow.up.left"
        case "right", "sharp_right", "exit_right", "ramp_right", "merge_right": return "arrow.turn.up.right"
        case "slight_right", "stay_right": return "arrow.up.right"
        case "u_turn_left", "u_turn_right": return "arrow.uturn.down"
        case "roundabout_enter", "roundabout_exit": return "arrow.triangle.2.circlepath"
        default: return "arrow.up"
        }
    }

    /// Bike-network pill (label + color), matching the overlay palette. Nil for an
    /// unclassified / mixed-traffic street.
    static func pill(_ cls: String?) -> (label: String, color: Color)? {
        switch cls {
        case "greenway": return ("Greenway", Color(red: 0.18, green: 0.62, blue: 0.28))   // #2E9E48
        case "protected": return ("Protected", Color(red: 0.427, green: 0.157, blue: 0.851)) // #6D28D9
        case "buffered": return ("Buffered", Color(red: 0.031, green: 0.569, blue: 0.698))  // #0891B2
        case "standard": return ("Bike lane", Color(red: 0.961, green: 0.620, blue: 0.043)) // #F59E0B
        case "off_street": return ("Path", Color(red: 0.706, green: 0.325, blue: 0.035))    // #B45309
        default: return nil
        }
    }
}
