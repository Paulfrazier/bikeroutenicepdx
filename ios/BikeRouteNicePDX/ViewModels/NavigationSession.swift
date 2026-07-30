import CoreLocation
import Observation
import UIKit

/// Where the rider is in a trip.
///
/// `arrived` is terminal. `pausedAtStop` is the leg boundary on a multi-stop
/// trip: guidance is suspended — GPS, voice, screen wake and the Live Activity
/// are all released — but the session stays bound so Continue can resume it.
///
/// This is deliberately an enum rather than a second boolean beside `arrived`.
/// `arrived` is load-bearing control flow (it suppresses arrival re-entry,
/// off-route evaluation, and the screen-wake invariant), so a pause state that
/// left it `false` would re-fire arrival on every queued fix, reroute the rider
/// while they're inside the shop, and re-acquire the wake lock on foregrounding.
enum NavPhase {
    case guiding
    case pausedAtStop
    case arrived
}

/// Live turn-by-turn navigation state. Sibling to `RouteStore` (which stays the
/// planner): when the rider taps "Start", this snapshots the planned route and
/// drives guidance off continuous GPS — chase-camera heading, step progression,
/// spoken/greenway-aware prompts, off-route auto-reroute, and arrival.
///
/// It deliberately does NOT own route *planning*. On reroute it publishes a fresh
/// route into `store.snapped` (so the map line updates) and restores the original
/// planned route when navigation ends, leaving vias/manual edits untouched.
///
/// A multi-stop trip is navigated **one leg at a time**: the session snapshots
/// the stop list at `start()` and only ever targets the current leg's end, so an
/// off-route reroute has nothing downstream to thread through. Arriving at an
/// intermediate stop pauses rather than finishes — see `NavPhase`.
@MainActor
@Observable
final class NavigationSession {
    // MARK: - Lifecycle state
    var isNavigating = false
    private(set) var navPhase: NavPhase = .guiding
    /// Terminal arrival — the whole trip is done. Read by the HUD, Live Activity
    /// and Watch bridge, all of which mean exactly that. Computed so every write
    /// site has to go through a phase transition.
    var arrived: Bool { navPhase == .arrived }
    var isRerouting = false
    /// Set when a Continue couldn't fetch the next leg (offline at the shop).
    /// The HUD offers a retry; the session stays paused rather than advancing.
    private(set) var resumeFailed = false

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

    /// Trip-wide greenway tally. `steps` only ever holds the *current* leg (and
    /// is replaced again on every reroute), so a Ride computed from it would
    /// describe the last geometry loaded rather than the trip. These accumulate
    /// the ridden portion of each route before it is thrown away.
    private var tripFriendlyMeters: Double = 0
    private var tripTotalMeters: Double = 0
    /// Whether the currently-loaded geometry has already been folded into the
    /// tally above. Reset by `load(route:)`.
    private var greenwayFolded = false

    // MARK: - Prompt bookkeeping (so each cue fires once per step per route)
    private var spokenPrepare: Set<Int> = []
    private var spokenNow: Set<Int> = []
    private var announcedEntry: Set<Int> = []
    private var offRouteSince: Date?
    private var lastRerouteAt: Date?
    /// Last utterance — drives the long-straight reassurance prompt.
    private var lastSpokenAt = Date()

    // MARK: - Trip / leg state
    //
    // A trip is a SNAPSHOT taken at `start()`: reading `store.stops` live would
    // let a mid-trip planner edit corrupt leg indexing. Navigation then walks
    // the snapshot one leg at a time, and only ever targets the current leg's
    // destination — which is what makes an off-route reroute correct with no
    // waypoints at all.

    /// Ordered intermediate stops for this trip, snapshotted at `start()`.
    private(set) var tripStops: [Via] = []
    /// The final destination, snapshotted at `start()`.
    private var tripEnd: Waypoint?
    /// Which leg we're on. Leg *i* ends at `tripStops[i]`; the last leg ends at
    /// `tripEnd`.
    private(set) var legIndex = 0
    /// Where the current leg ends — the only thing navigation ever targets.
    private(set) var legDestination: CLLocationCoordinate2D?
    /// Display name of the current leg's destination, if it has one.
    private(set) var legLabel: String?

    /// True when this trip has intermediate stops at all. A plain A→B trip takes
    /// the original whole-route path end to end.
    var isMultiStop: Bool { !tripStops.isEmpty }
    /// Total legs in the trip (stops + the final destination).
    var legCount: Int { tripStops.count + 1 }
    /// "Stop 1 of 2" while heading to an intermediate stop, "Final leg" on the
    /// run to the destination. Nil on a plain A→B trip, which has no legs to
    /// count and shows no chip at all.
    var legProgressLabel: String? {
        guard isMultiStop else { return nil }
        return isFinalLeg ? "Final leg" : "Stop \(legIndex + 1) of \(tripStops.count)"
    }

    /// Whether to offer the manual "I'm here" affordance: on a multi-stop trip,
    /// while actually guiding, once we're in the neighbourhood of an
    /// intermediate stop. The final leg doesn't need it — End already finishes
    /// the trip and banks the Ride.
    var showManualArrival: Bool {
        navPhase == .guiding && isMultiStop && !isFinalLeg
            && distanceRemaining < Self.manualArrivalWithinM
    }

    /// Name of the *next* leg's destination — the "Continue to X" label.
    var nextLegLabel: String? {
        let next = legIndex + 1
        if next < tripStops.count { return tripStops[next].label }
        if next == tripStops.count { return tripEnd?.label }
        return nil
    }

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

    // MARK: - Arrival + off-route thresholds
    //
    // Named because they are shared cross-surface (see scripts/check-parity.ts)
    // and because leaving them as inline literals is how the old stop-proximity
    // radius came to overlap the off-route radius unnoticed.

    /// Terminal arrival: the trip is over.
    static let arrivedMeters: Double = 15
    /// Leg arrival at an intermediate stop. Deliberately more generous than
    /// terminal arrival — the rider parks, locks up, and walks the last few
    /// metres, and if this never fires they never get a Continue button. The
    /// HUD's manual "I'm here" is the backstop when even this misses.
    static let legArrivedMeters: Double = 30
    /// Perpendicular distance from the route line before we consider rerouting.
    /// (Named `…ThresholdM` so it doesn't shadow the `offRouteMeters` reading.)
    static let offRouteThresholdM: Double = 30
    /// Show the manual "I'm here" affordance inside this range of the leg end.
    static let manualArrivalWithinM: Double = 150

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
    ///
    /// On a multi-stop trip this snapshots the stop list and guides on **leg 0
    /// only**, sliced out of the route the rider just reviewed — no extra
    /// network call, and the line is exactly what they saw in the planner. A
    /// plain A→B trip has no legs to slice and takes the whole route unchanged.
    func start() {
        guard let snap = store?.snapped, snap.coordinates.count >= 2 else { return }
        originalSnapped = snap
        tripStops = store?.stops ?? []
        tripEnd = store?.end
        legIndex = 0
        retargetLeg()
        tripFriendlyMeters = 0
        tripTotalMeters = 0
        load(route: legRoute(from: snap, leg: 0) ?? snap)
        traceLocations = []
        rideStartedAt = Date()
        navPhase = .guiding
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
        navPhase = .guiding
        isRerouting = false
        hudDimmed = false
        // Restore the planned route under the map.
        if let original = originalSnapped { store?.snapped = original }
        originalSnapped = nil
        currentLocation = nil
        clearTripState()
        return ride
    }

    /// Write the resume record. Only meaningful for a multi-stop trip — a plain
    /// A→B ride has nothing to resume to.
    private func persistTripProgress() {
        guard isMultiStop, let end = tripEnd, let started = rideStartedAt else { return }
        TripProgressStore.save(
            TripProgress(
                stops: tripStops.map { TripProgress.Place($0.coordinate, label: $0.label) },
                end: TripProgress.Place(end.coordinate, label: end.label),
                legIndex: legIndex,
                startedAt: started
            )
        )
    }

    /// Drop the trip snapshot and its persisted resume record. Called on the
    /// one-per-trip teardown, never on a leg boundary.
    private func clearTripState() {
        tripStops = []
        tripEnd = nil
        legIndex = 0
        legDestination = nil
        legLabel = nil
        TripProgressStore.clear()
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
        arcAlong = 0
        greenwayFolded = false
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
        // Only the guiding phase drives progress. `provider.stop()` does not
        // cancel fixes already queued, so without this gate a straggler landing
        // after a leg pause would re-fire arrival and restart the whole cadence.
        guard navPhase == .guiding, let loc = currentLocation,
              routeCoords.count >= 2 else { return }
        arcAlong = GeoMath.arcLength(of: loc, in: routeCoords)
        offRouteMeters = GeoMath.distanceToPolyline(loc, routeCoords)
        distanceRemaining = max(0, totalLength - arcAlong)
        if durationSeconds > 0, totalLength > 0 {
            timeRemaining = durationSeconds * (distanceRemaining / totalLength)
        }
        updateStepProgress()
        if distanceRemaining < arrivalRadius {
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

    /// True when the current leg ends at the trip's final destination.
    var isFinalLeg: Bool { legIndex >= tripStops.count }

    /// How close counts as arriving at the current leg's end. Intermediate stops
    /// get the more generous radius — see `legArrivedMeters`.
    private var arrivalRadius: Double {
        isFinalLeg ? Self.arrivedMeters : Self.legArrivedMeters
    }

    /// Point the session at leg `legIndex`'s destination — the only thing
    /// navigation ever targets.
    private func retargetLeg() {
        if legIndex < tripStops.count {
            legDestination = tripStops[legIndex].coordinate
            legLabel = tripStops[legIndex].label
        } else {
            legDestination = tripEnd?.coordinate
            legLabel = tripEnd?.label
        }
    }

    /// Slice one leg out of an already-fetched multi-stop route: the coordinate
    /// span `legs[i].coord_start...coord_end` plus the steps tagged with that
    /// `leg_index`. Returns nil when the route carries no leg breakdown (a plain
    /// A→B trip), so callers fall back to the whole route unchanged.
    private func legRoute(from route: SnappedRoute, leg: Int) -> SnappedRoute? {
        guard route.legs.indices.contains(leg) else { return nil }
        let span = route.legs[leg]
        let coords = route.coordinates
        guard span.coord_start >= 0, span.coord_end < coords.count,
              span.coord_start < span.coord_end else { return nil }
        var sliced = route
        sliced.coordinates = Array(coords[span.coord_start...span.coord_end])
        sliced.steps = route.steps.filter { $0.leg_index == leg }
        // Classes are per-segment, so one shorter than the coordinate span.
        sliced.routeClasses = route.routeClasses.map {
            Array($0[span.coord_start..<min(span.coord_end, $0.count)])
        }
        sliced.distanceMeters = span.distance_m
        sliced.durationSeconds = span.duration_s
        sliced.coverage = span.greenway_coverage
        sliced.legs = []
        return sliced
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
        guard !calmMode, offRouteMeters <= Self.offRouteThresholdM,
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
        guard isNavigating, !isRerouting, navPhase == .guiding else { return }
        if offRouteMeters > Self.offRouteThresholdM {
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

    /// Recompute current → **this leg's** destination via the planner's BRouter
    /// path (keeps greenway quality), swap it under the map, and continue
    /// guiding on it.
    ///
    /// No waypoints. With navigation scoped to a single leg there is nothing
    /// downstream to thread through, so the `vias: []` behaviour that used to
    /// silently cancel the rest of an errand is now correct by construction.
    private func reroute() async {
        guard let store, let from = currentLocation, let end = legDestination else { return }
        isRerouting = true
        lastRerouteAt = Date()
        say("Off route — rerouting.")
        if let fresh = await store.navReroute(from: from, to: end) {
            // Fold in what was actually ridden before discarding this geometry.
            accumulateRiddenGreenway()
            load(route: fresh)
            // Re-anchor progress to the fresh geometry immediately.
            recomputeProgress()
        }
        offRouteSince = nil
        isRerouting = false
    }

    // MARK: - Arrival

    /// End of a leg. On the final leg this is the trip's terminal arrival. On an
    /// intermediate stop it is a *pause*: everything is released exactly as
    /// before, but the session stays bound so `resume()` can pick it up — and
    /// the trip is written to disk so it survives the app being killed while
    /// the rider is inside the shop.
    private func handleArrival() {
        setScreenWake(false)
        hudDimmed = false
        nextManeuverIndex = nil
        distanceToNextManeuver = 0
        distanceRemaining = 0
        voice.turnHaptic()
        if isFinalLeg {
            navPhase = .arrived
            voice.speak("You've arrived. Enjoy the ride.")
            TripProgressStore.clear()
        } else {
            navPhase = .pausedAtStop
            let here = legLabel.map { "Arrived at \($0)." } ?? "Arrived at your stop."
            let onward = nextLegLabel.map { " Continue to \($0) when you're ready." } ?? ""
            voice.speak(here + onward)
            persistTripProgress()
        }
        provider.stop()
        liveActivityEnd()
        watchEnd()
    }

    /// Manual "I'm here". The rider tells us they've arrived instead of waiting
    /// for the radius to fire — the backstop for locking up across the street,
    /// where proximity alone would leave them with no Continue button at all.
    func declareArrival() {
        guard navPhase == .guiding else { return }
        handleArrival()
    }

    /// Continue to the next leg.
    ///
    /// Fetches a **fresh** route from wherever the rider is standing now, rather
    /// than slicing the next leg out of the original plan: after twenty minutes
    /// they're round the corner from where that leg started, and a sliced line
    /// would begin metres away and immediately trigger an off-route reroute.
    /// Better a deliberate re-route than an emergent one.
    ///
    /// Must not touch `traceLocations` / `rideStartedAt` — accumulating the
    /// trace across legs is what yields one Ride for the whole trip.
    func resume() async {
        guard navPhase == .pausedAtStop, !isFinalLeg,
              let store, let from = currentLocation else { return }
        legIndex += 1
        retargetLeg()
        guard let end = legDestination else {
            legIndex -= 1
            retargetLeg()
            return
        }
        isRerouting = true
        resumeFailed = false
        guard let fresh = await store.navReroute(from: from, to: end) else {
            // Stay paused and surface a retry. Never strand the rider in a
            // half-advanced state with GPS off.
            legIndex -= 1
            retargetLeg()
            isRerouting = false
            resumeFailed = true
            return
        }
        // Fold in the leg just finished before its geometry is discarded.
        accumulateRiddenGreenway()
        load(route: fresh)
        navPhase = .guiding
        isRerouting = false
        offRouteSince = nil
        hudDimmed = false
        dimWakeUntil = .distantPast
        persistTripProgress()
        setScreenWake(true)
        voice.activate()
        provider.start()
        liveActivityStart()
        lastSpokenAt = Date()
        voice.speak(legLabel.map { "Continuing to \($0)." } ?? "Continuing.")
        recomputeProgress()
    }

    /// Skip the current stop without visiting it (the bakery turned out to be
    /// closed) and carry on to the next leg.
    func skipStop() async {
        guard !isFinalLeg else { return }
        if navPhase == .guiding { navPhase = .pausedAtStop }
        await resume()
    }

    // MARK: - Battery-saver dim + adaptive GPS

    /// Dim the map on a long quiet straight; wake approaching the turn,
    /// off-route, rerouting, or within the tap-wake window (hysteresis so it
    /// doesn't flicker at the boundary). Mirrors web.
    private func evaluateDim() {
        let wakeHeld = Date() < dimWakeUntil
        if hudDimmed {
            if distanceToNextManeuver < Self.undimWithinM || offRouteMeters > Self.offRouteThresholdM
                || isRerouting || wakeHeld {
                hudDimmed = false
            }
        } else if !wakeHeld,
                  distanceToNextManeuver > Self.dimBeyondM,
                  offRouteMeters <= Self.offRouteThresholdM,
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
    /// disabled ⇔ (foreground + navigating + actively guiding).
    private func setScreenWake(_ on: Bool) {
        UIApplication.shared.isIdleTimerDisabled = on
    }

    /// Re-assert the wake invariant on scene-phase transitions (the app calls
    /// this): background always releases; returning to foreground re-acquires
    /// only while actually guiding. Keyed on the phase, not on `arrived` — a
    /// rider paused at a stop must not have the screen pinned on for the twenty
    /// minutes they're inside the shop.
    func syncScreenWake(foreground: Bool) {
        setScreenWake(foreground && isNavigating && navPhase == .guiding)
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
        // Wall-clock: a multi-stop errand's Ride spans the whole outing,
        // including the time spent at each stop. Deliberate — it answers "how
        // long did that trip take" — but it means average speed derived from
        // these two numbers is not a riding speed.
        let duration = (traceLocations.last?.timestamp ?? Date()).timeIntervalSince(started)
        // Fold in the leg still loaded, then report the trip-wide share.
        accumulateRiddenGreenway()
        let ride = Ride(
            date: started,
            distanceMeters: distance,
            durationSeconds: max(duration, 0),
            greenwayShare: tripGreenwayShare,
            coordinates: coords
        )
        RideStore.shared.add(ride)
        rideStartedAt = nil
        return ride
    }

    /// Length-weighted share of the trip ridden on comfortable infrastructure
    /// (rank ≥ 2), across every leg and every reroute.
    private var tripGreenwayShare: Double {
        tripTotalMeters > 0 ? tripFriendlyMeters / tripTotalMeters : 0
    }

    /// Fold the portion of the currently-loaded route the rider actually covered
    /// into the trip-wide tally, then leave it consumed.
    ///
    /// Called immediately before any geometry swap (leg transition or reroute)
    /// and once at teardown. Without this the Ride's greenway share would
    /// describe only the last geometry loaded — the final leg of a multi-stop
    /// trip, or whatever a late reroute happened to produce.
    private func accumulateRiddenGreenway() {
        guard !greenwayFolded, totalLength > 0, !steps.isEmpty else { return }
        let ridden = min(max(arcAlong, 0), totalLength)
        guard ridden > 0 else { return }
        let planned = steps.reduce(0) { $0 + $1.distance_m }
        guard planned > 0 else { return }
        let friendly = steps.filter { protectionRank($0.bicycle_network_class) >= 2 }
            .reduce(0) { $0 + $1.distance_m }
        // Assume the facility mix is uniform along the leg — the same
        // approximation the original whole-route calculation made.
        let fraction = ridden / totalLength
        tripTotalMeters += planned * fraction
        tripFriendlyMeters += friendly * fraction
        // Consumed until the next `load(route:)`, so a stray second call before
        // the geometry actually swaps cannot double-count it.
        greenwayFolded = true
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
