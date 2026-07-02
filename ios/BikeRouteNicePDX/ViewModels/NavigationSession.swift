import CoreLocation
import Observation
import UIKit

/// Live turn-by-turn navigation state. Sibling to `RouteStore` (which stays the
/// planner): when the rider taps "Start", this snapshots the planned route and
/// drives guidance off continuous GPS — chase-camera heading, step progression,
/// spoken/greenway-aware prompts, off-route auto-reroute, and arrival.
///
/// It deliberately does NOT own route *planning*. On reroute it publishes a fresh
/// route into `store.snapped` (so the map line updates) and restores the original
/// planned route when navigation ends, leaving vias/manual edits untouched.
@MainActor
@Observable
final class NavigationSession {
    // MARK: - Lifecycle state
    var isNavigating = false
    var arrived = false
    var isRerouting = false

    // MARK: - Live position
    var currentLocation: CLLocationCoordinate2D?
    /// Heading for the chase camera: GPS course while moving, compass otherwise.
    var course: CLLocationDirection = 0
    /// Bumped on every fix so the map coordinator can drive the camera via the
    /// normal SwiftUI updateUIView path (mirrors RouteStore's tick pattern).
    private(set) var fixVersion = 0

    // MARK: - Derived progress
    var arcAlong: Double = 0
    var distanceRemaining: Double = 0
    var timeRemaining: Double = 0
    var offRouteMeters: Double = 0
    /// Index into `steps` of the maneuver we're currently heading toward.
    var nextManeuverIndex: Int?
    var currentStepIndex = 0
    var distanceToNextManeuver: Double = 0
    /// EMA-smoothed ground speed (m/s) — HUD readout + chase-camera zoom
    /// (raw GPS speed jitters).
    private(set) var smoothedSpeed: Double = 0
    /// Battery saver: true when the map dim overlay should show.
    private(set) var hudDimmed = false

    // MARK: - User options
    /// Calm mode: speak only turns and busy-street warnings — skip the routine
    /// "continue on the greenway" affirmations. Fits the relaxed-cyclist ethos.
    var calmMode = false
    var voiceEnabled = true {
        didSet { voice.voiceEnabled = voiceEnabled }
    }

    // MARK: - Route snapshot
    private(set) var routeCoords: [CLLocationCoordinate2D] = []
    private(set) var steps: [RouteStep] = []
    private var stepArcs: [Double] = []
    private var totalLength: Double = 0
    private var durationSeconds: Double = 0

    /// The planned route to restore when navigation ends (reroutes overwrite
    /// `store.snapped`; this puts the rider's plan back).
    private var originalSnapped: SnappedRoute?

    // MARK: - Collaborators
    private weak var store: RouteStore?
    private let provider = NavigationLocationProvider()
    let voice = VoiceGuide()

    /// Raw GPS trace accumulated during the ride (Phase 6 — ride recording).
    private(set) var traceLocations: [CLLocation] = []
    private var rideStartedAt: Date?

    // MARK: - Prompt bookkeeping (so each cue fires once per step per route)
    private var spokenPrepare: Set<Int> = []
    private var spokenNow: Set<Int> = []
    private var announcedEntry: Set<Int> = []
    private var offRouteSince: Date?
    private var lastRerouteAt: Date?
    /// Last utterance — drives the long-straight reassurance prompt.
    private var lastSpokenAt = Date()

    /// Quiet-period + upcoming-turn gates for reassurance (mirrors web).
    private static let reassureAfterS: TimeInterval = 120
    private static let reassureMinAheadM: Double = 400
    /// A following maneuver within this distance chains into one prompt.
    private static let chainWithinM: Double = 40

    // MARK: - Battery-saver dim (mirrors web)
    private static let dimAfterQuietS: TimeInterval = 20
    private static let dimBeyondM: Double = 300
    private static let undimWithinM: Double = 220
    private static let dimTapWakeS: TimeInterval = 30
    /// Tap-to-wake: stay undimmed until this time.
    private var dimWakeUntil = Date.distantPast

    // MARK: - Adaptive GPS (cruise on long straights)
    private static let cruiseBeyondM: Double = 400
    private static let cruiseMaxOffRouteM: Double = 15

    // MARK: - Wiring

    func bind(_ store: RouteStore) {
        self.store = store
        provider.onLocation = { [weak self] loc in self?.ingest(loc) }
        provider.onHeading = { [weak self] heading in
            guard let self, self.isNavigating else { return }
            // Use compass only when essentially stopped (GPS course is junk then).
            if self.currentLocation == nil || self.lastSpeed < 1.0 { self.course = heading }
        }
        voice.voiceEnabled = voiceEnabled
    }

    private var lastSpeed: Double = 0

    // MARK: - Start / stop

    /// Begin navigating the currently planned route (`store.snapped`).
    func start() {
        guard let snap = store?.snapped, snap.coordinates.count >= 2 else { return }
        originalSnapped = snap
        load(route: snap)
        traceLocations = []
        rideStartedAt = Date()
        arrived = false
        isNavigating = true
        smoothedSpeed = 0
        hudDimmed = false
        dimWakeUntil = .distantPast
        setScreenWake(true)
        voice.activate()
        lastSpokenAt = Date()
        // Prefer the synthesized "Head east on X" opener; else the first turn.
        let opener: String
        if let first = steps.first, first.maneuver_type.hasPrefix("start") {
            opener = upperFirst(clauseOf(first))
        } else {
            opener = steps.first(where: { isTurn($0.maneuver_type) })?.instruction ?? "Follow the route."
        }
        voice.speak("Starting navigation. \(opener.hasSuffix(".") ? opener : opener + ".")")
        provider.start()
        liveActivityStart()
    }

    /// Stop navigating and restore the planned route. Returns the finished ride
    /// (Phase 6) so the caller can persist it, or nil if nothing meaningful rode.
    @discardableResult
    func stop() -> Ride? {
        let ride = finishRide()
        setScreenWake(false)
        provider.stop()
        voice.deactivate()
        liveActivityEnd()
        watchEnd()
        isNavigating = false
        arrived = false
        isRerouting = false
        hudDimmed = false
        // Restore the planned route under the map.
        if let original = originalSnapped { store?.snapped = original }
        originalSnapped = nil
        currentLocation = nil
        return ride
    }

    /// Load a route snapshot and reset per-route prompt state.
    private func load(route: SnappedRoute) {
        routeCoords = route.coordinates
        steps = route.steps
        durationSeconds = route.durationSeconds
        totalLength = GeoMath.length(routeCoords)
        stepArcs = steps.map {
            GeoMath.arcLength(
                of: CLLocationCoordinate2D(latitude: $0.location[1], longitude: $0.location[0]),
                in: routeCoords
            )
        }
        spokenPrepare = []
        spokenNow = []
        announcedEntry = []
        currentStepIndex = 0
        nextManeuverIndex = stepArcs.isEmpty ? nil : 0
    }

    // MARK: - Fix ingestion

    func ingest(_ location: CLLocation) {
        guard isNavigating else { return }
        currentLocation = location.coordinate
        lastSpeed = max(0, location.speed)
        smoothedSpeed = smoothedSpeed == 0 ? lastSpeed : smoothedSpeed * 0.7 + lastSpeed * 0.3
        if location.course >= 0 && location.speed > 1.0 { course = location.course }
        traceLocations.append(location)
        fixVersion &+= 1
        recomputeProgress()
    }

    private func recomputeProgress() {
        guard let loc = currentLocation, routeCoords.count >= 2 else { return }
        arcAlong = GeoMath.arcLength(of: loc, in: routeCoords)
        offRouteMeters = GeoMath.distanceToPolyline(loc, routeCoords)
        distanceRemaining = max(0, totalLength - arcAlong)
        if durationSeconds > 0, totalLength > 0 {
            timeRemaining = durationSeconds * (distanceRemaining / totalLength)
        }
        updateStepProgress()
        if !arrived, distanceRemaining < 15 {
            handleArrival()
            return
        }
        evaluateVoice()
        evaluateReassurance()
        evaluateOffRoute()
        evaluateDim()
        evaluateCruise()
        liveActivityUpdate()
        watchUpdate()
    }

    /// The next maneuver = first step whose arc-length is meaningfully ahead of us.
    private func updateStepProgress() {
        var idx = 0
        while idx < stepArcs.count, stepArcs[idx] <= arcAlong + 2 { idx += 1 }
        if idx < steps.count {
            nextManeuverIndex = idx
            distanceToNextManeuver = max(0, stepArcs[idx] - arcAlong)
        } else {
            nextManeuverIndex = nil
            distanceToNextManeuver = distanceRemaining
        }
        let entered = max(0, idx - 1)
        if entered != currentStepIndex {
            currentStepIndex = entered
            announceStepEntry(entered)
        }
    }

    // MARK: - Voice staging

    /// Speak and stamp the quiet-period clock (reassurance timing).
    private func say(_ text: String) {
        lastSpokenAt = Date()
        voice.speak(text)
    }

    /// Step's TTS clause, lowercase-first (server `spoken`, else instruction).
    private func clauseOf(_ step: RouteStep) -> String {
        lowerFirst(step.spoken ?? step.instruction)
    }

    private func evaluateVoice() {
        guard let idx = nextManeuverIndex, steps.indices.contains(idx) else { return }
        let step = steps[idx]
        guard isTurn(step.maneuver_type) else { return }
        let d = distanceToNextManeuver
        // A maneuver right after this turn joins the same prompt.
        let following: RouteStep? =
            step.distance_m < Self.chainWithinM && steps.indices.contains(idx + 1)
                && isTurn(steps[idx + 1].maneuver_type) ? steps[idx + 1] : nil
        // "Prepare" cue — scaled a little to speed so fast riders hear it sooner.
        let prepareAt = min(220, max(120, lastSpeed * 12 + 120))
        if d <= prepareAt, !spokenPrepare.contains(idx) {
            spokenPrepare.insert(idx)
            voice.prepareHaptic()
            say("\(VoiceGuide.spokenDistance(d)), \(clauseOf(step))")
        }
        // "Now" cue at the turn, chaining a back-to-back follow-up.
        if d <= 30, !spokenNow.contains(idx) {
            spokenNow.insert(idx)
            voice.turnHaptic()
            var text = upperFirst(clauseOf(step))
            if let following {
                text += ", then immediately \(clauseOf(following))"
                spokenPrepare.insert(idx + 1) // its own prepare cue would be redundant
            }
            say(text)
        }
    }

    /// Long-straight reassurance: quiet for a while, no turn coming up, still
    /// on route → confirm the rider hasn't been forgotten. Calm mode skips it.
    private func evaluateReassurance() {
        guard !calmMode, offRouteMeters <= 30,
              distanceToNextManeuver > Self.reassureMinAheadM,
              Date().timeIntervalSince(lastSpokenAt) > Self.reassureAfterS else { return }
        let ahead = VoiceGuide.spokenDistanceBare(distanceToNextManeuver)
        if let street = currentStep?.street_name {
            say("Continue on \(street) for \(ahead).")
        } else {
            say("Continue for \(ahead).")
        }
    }

    // MARK: - Greenway-aware announcements (Phase 4)

    /// Spoken when the rider crosses into a new route step: affirm a greenway, or
    /// warn before an exposed busy-street stretch.
    private func announceStepEntry(_ index: Int) {
        guard steps.indices.contains(index), !announcedEntry.contains(index) else { return }
        announcedEntry.insert(index)
        let step = steps[index]
        let rank = protectionRank(step.bicycle_network_class)
        let prevRank = index > 0 ? protectionRank(steps[index - 1].bicycle_network_class) : rank

        // Downgrade onto a busy/standard street → warn with the exposed distance.
        if rank <= 1, prevRank >= 2 {
            let exposed = exposedBusyDistance(from: index)
            voice.prepareHaptic()
            say("Heads up — busy street for \(VoiceGuide.spokenDistanceBare(exposed)), then back to the bikeway.")
            return
        }
        // Upgrade onto comfortable bike infra → affirm (suppressed in calm mode).
        if !calmMode, rank >= 3, prevRank < 3, !isTurn(step.maneuver_type) {
            if let name = step.street_name, step.bicycle_network_class == "greenway" {
                say("Now on the \(name) greenway.")
            } else if step.bicycle_network_class == "protected" || step.bicycle_network_class == "off_street" {
                say("Now on protected bike lane\(step.street_name.map { " on \($0)" } ?? "").")
            }
        }
    }

    /// Total distance of consecutive busy (rank ≤ 1) steps starting at `index`,
    /// until the route returns to comfortable infrastructure.
    private func exposedBusyDistance(from index: Int) -> Double {
        var total = 0.0
        var i = index
        while i < steps.count, protectionRank(steps[i].bicycle_network_class) <= 1 {
            total += steps[i].distance_m
            i += 1
        }
        return total
    }

    /// Comfort ranking of a server bike-network class: 3 = calm/separated,
    /// 2 = buffered, ≤1 = mixed-traffic / unknown.
    private func protectionRank(_ cls: String?) -> Int {
        switch cls {
        case "off_street", "greenway", "protected": return 3
        case "buffered": return 2
        case "standard", "lane": return 1
        default: return 0
        }
    }

    // MARK: - Off-route auto-reroute (Phase 3)

    private func evaluateOffRoute() {
        guard isNavigating, !isRerouting, !arrived else { return }
        if offRouteMeters > 30 {
            if offRouteSince == nil { offRouteSince = Date() }
            let offFor = Date().timeIntervalSince(offRouteSince ?? Date())
            let sinceLast = lastRerouteAt.map { Date().timeIntervalSince($0) } ?? .infinity
            // Sustained deviation (not GPS jitter) + a cooldown since the last try.
            if offFor > 5, sinceLast > 15 {
                Task { await reroute() }
            }
        } else {
            offRouteSince = nil
        }
    }

    /// Recompute current → destination via the planner's BRouter path (keeps
    /// greenway quality), swap it under the map, and continue guiding on it.
    private func reroute() async {
        guard let store, let from = currentLocation, let end = store.end?.coordinate else { return }
        isRerouting = true
        lastRerouteAt = Date()
        say("Off route — rerouting.")
        if let fresh = await store.navReroute(from: from, to: end) {
            load(route: fresh)
            // Re-anchor progress to the fresh geometry immediately.
            recomputeProgress()
        }
        offRouteSince = nil
        isRerouting = false
    }

    // MARK: - Arrival

    private func handleArrival() {
        arrived = true
        setScreenWake(false)
        hudDimmed = false
        nextManeuverIndex = nil
        distanceToNextManeuver = 0
        distanceRemaining = 0
        voice.turnHaptic()
        voice.speak("You've arrived. Enjoy the ride.")
        provider.stop()
        liveActivityEnd()
        watchEnd()
    }

    // MARK: - Battery-saver dim + adaptive GPS

    /// Dim the map on a long quiet straight; wake approaching the turn,
    /// off-route, rerouting, or within the tap-wake window (hysteresis so it
    /// doesn't flicker at the boundary). Mirrors web.
    private func evaluateDim() {
        let wakeHeld = Date() < dimWakeUntil
        if hudDimmed {
            if distanceToNextManeuver < Self.undimWithinM || offRouteMeters > 30
                || isRerouting || wakeHeld {
                hudDimmed = false
            }
        } else if !wakeHeld,
                  distanceToNextManeuver > Self.dimBeyondM,
                  offRouteMeters <= 30,
                  !isRerouting,
                  Date().timeIntervalSince(lastSpokenAt) > Self.dimAfterQuietS {
            hudDimmed = true
        }
    }

    /// Tap-to-wake from the dim overlay.
    func wakeDim() {
        dimWakeUntil = Date().addingTimeInterval(Self.dimTapWakeS)
        hudDimmed = false
    }

    /// Relax GPS precision on long on-route straights (nothing to announce,
    /// nothing to miss), back to full precision approaching a maneuver or when
    /// drifting. Thresholds stay conservative so the 30 m off-route detector
    /// still fires promptly.
    private func evaluateCruise() {
        provider.setCruise(
            distanceToNextManeuver > Self.cruiseBeyondM
                && offRouteMeters < Self.cruiseMaxOffRouteM
        )
    }

    // MARK: - Screen wake

    /// Keep the display on while actively navigating — the map is the rider's
    /// dashboard. `isIdleTimerDisabled` is app-global, so the invariant is:
    /// disabled ⇔ (foreground + navigating + not arrived).
    private func setScreenWake(_ on: Bool) {
        UIApplication.shared.isIdleTimerDisabled = on
    }

    /// Re-assert the wake invariant on scene-phase transitions (the app calls
    /// this): background always releases; returning to foreground re-acquires
    /// only if a ride is still in progress.
    func syncScreenWake(foreground: Bool) {
        setScreenWake(foreground && isNavigating && !arrived)
    }

    // MARK: - Ride recording (Phase 6)

    /// Finalize the accumulated trace into a `Ride` and persist it. Returns nil
    /// for a trivially short ride (e.g. started + immediately ended).
    @discardableResult
    private func finishRide() -> Ride? {
        guard let started = rideStartedAt, traceLocations.count >= 2 else { return nil }
        let coords = traceLocations.map(\.coordinate)
        let distance = GeoMath.length(coords)
        guard distance > 50 else { return nil }
        let duration = (traceLocations.last?.timestamp ?? Date()).timeIntervalSince(started)
        // Greenway share: fraction of the *planned* route length on comfortable
        // infra (rank ≥ 2), a close proxy for the ride that followed it.
        let greenwayPct = plannedGreenwayShare()
        let ride = Ride(
            date: started,
            distanceMeters: distance,
            durationSeconds: max(duration, 0),
            greenwayShare: greenwayPct,
            coordinates: coords
        )
        RideStore.shared.add(ride)
        rideStartedAt = nil
        return ride
    }

    /// Length-weighted share of route steps on comfortable infrastructure.
    private func plannedGreenwayShare() -> Double {
        let total = steps.reduce(0) { $0 + $1.distance_m }
        guard total > 0 else { return 0 }
        let friendly = steps.filter { protectionRank($0.bicycle_network_class) >= 2 }
            .reduce(0) { $0 + $1.distance_m }
        return friendly / total
    }

    // MARK: - External surfaces (Live Activity / Watch) — wired in their phases

    private func liveActivityStart() { LiveActivityController.shared.start(self) }
    private func liveActivityUpdate() { LiveActivityController.shared.update(self) }
    private func liveActivityEnd() { LiveActivityController.shared.end() }
    private func watchUpdate() { WatchBridge.shared.send(self) }
    private func watchEnd() { WatchBridge.shared.sendEnd() }

    // MARK: - Display helpers (read by the HUD)

    var currentStep: RouteStep? { steps.indices.contains(currentStepIndex) ? steps[currentStepIndex] : nil }
    var nextStep: RouteStep? { nextManeuverIndex.flatMap { steps.indices.contains($0) ? steps[$0] : nil } }

    /// The turn after `nextStep` — drives the HUD "then" preview chip.
    var followingStep: RouteStep? {
        guard let idx = nextManeuverIndex, steps.indices.contains(idx + 1),
              isTurn(steps[idx + 1].maneuver_type) else { return nil }
        return steps[idx + 1]
    }

    /// Ridden fraction of the route, 0–1 — the HUD progress bar.
    var progressFraction: Double {
        totalLength > 0 ? min(1, max(0, arcAlong / totalLength)) : 0
    }

    var speedMph: Int { Int((smoothedSpeed * 2.23694).rounded()) }

    var distanceRemainingLabel: String {
        let miles = distanceRemaining / 1609.344
        if miles < 0.1 { return "\(Int((distanceRemaining * 3.28084).rounded())) ft" }
        return String(format: "%.1f mi", miles)
    }

    var etaLabel: String {
        guard timeRemaining > 0 else { return "—" }
        let min = Int((timeRemaining / 60).rounded())
        if min < 1 { return "<1 min" }
        if min < 60 { return "\(min) min" }
        return "\(min / 60) h \(min % 60) min"
    }

    var distanceToNextLabel: String {
        let feet = distanceToNextManeuver * 3.28084
        if feet < 1000 { return "\(max(0, Int((feet / 10).rounded()) * 10)) ft" }
        return String(format: "%.1f mi", distanceToNextManeuver / 1609.344)
    }

    // MARK: - Small utilities

    private func isTurn(_ type: String) -> Bool {
        type.contains("left") || type.contains("right") || type.contains("roundabout")
            || type.contains("uturn") || type.contains("u_turn") || type.contains("ferry")
    }

    private func lowerFirst(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.lowercased() + s.dropFirst()
    }

    private func upperFirst(_ s: String) -> String {
        guard let first = s.first else { return s }
        return first.uppercased() + s.dropFirst()
    }
}
