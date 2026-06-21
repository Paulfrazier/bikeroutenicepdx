import WidgetKit
import SwiftUI

/// Widget extension bundle. Hosts the turn-by-turn Live Activity (lock screen +
/// Dynamic Island). No home-screen widgets — navigation only.
@main
struct BikeNavWidgetBundle: WidgetBundle {
    var body: some Widget {
        NavLiveActivity()
    }
}
