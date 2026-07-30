/**
 * useNavigation — live turn-by-turn navigation session (web, foreground).
 *
 * The browser counterpart to the iOS NavigationSession. Watches GPS, projects
 * onto the active route to derive progress + the next maneuver, speaks staged
 * voice prompts (Web Speech API) with greenway-aware warnings, drives a chase
 * camera, and auto-reroutes via /route when the rider goes off-route.
 *
 * Browser limits vs. native: no background/locked guidance (the page must stay
 * foregrounded), no Live Activity, no watch. Those stay iOS-only.
 *
 * Live nav state that the watch callback reads lives in a ref (no stale
 * closures); a mirror is kept in React state for rendering.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { LngLat, RouteLeg, RouteResponse, RouteStep, Via } from "../types";
import { fetchRoute } from "../api";
import { useWakeLock } from "./useWakeLock";
import { haversineLength, arcLengthAt } from "../geo";
import {
  CURRENT_VERSION,
  clearTripProgress,
  saveTripProgress,
  type TripPlace,
} from "../tripProgress";
import {
  distanceToPolyline,
  computeStepArcs,
  routeBearingAhead,
  protectionRank,
  isTurn,
  spokenDistance,
  spokenDistanceBare,
} from "../navigation";

/**
 * Where the rider is in a trip.
 *
 * "arrived" is terminal. "pausedAtStop" is the leg boundary on a multi-stop
 * trip: guidance is suspended (GPS watch released, voice quiet, wake lock
 * dropped) but the session stays alive so Continue can resume it.
 *
 * Deliberately an enum rather than a second boolean beside `arrived`: `arrived`
 * is load-bearing control flow here too (it gates arrival re-entry and the wake
 * lock), so a pause that left it false would re-fire arrival on every fix and
 * pin the screen on for the whole stop. Mirrors iOS `NavPhase`.
 */
export type NavPhase = "guiding" | "pausedAtStop" | "arrived";

/**
 * Arrival + off-route thresholds. Named (and asserted in
 * `scripts/check-parity.ts`) because they are shared with iOS, and because
 * leaving them as inline literals is how the old stop radius came to overlap
 * the off-route radius unnoticed.
 */
export const ARRIVED_METERS = 15;
/** Leg arrival at an intermediate stop — generous, see iOS `legArrivedMeters`. */
export const LEG_ARRIVED_METERS = 30;
export const OFF_ROUTE_METERS = 30;
/** Offer the manual "I'm here" affordance inside this range of the leg end. */
export const MANUAL_ARRIVAL_WITHIN_M = 150;

export interface NavView {
  navigating: boolean;
  arrived: boolean;
  phase: NavPhase;
  /** Name of the current leg's destination, when it has one. */
  legLabel: string | null;
  /** Name of the next leg's destination — the "Continue to X" label. */
  nextLegLabel: string | null;
  /** "Stop 1 of 2" / "Final leg"; null on a plain A→B trip. */
  legProgressLabel: string | null;
  /** Whether to show the manual "I'm here" button. */
  showManualArrival: boolean;
  /** A Continue that couldn't fetch the next leg (offline at the shop). */
  resumeFailed: boolean;
  rerouting: boolean;
  voiceEnabled: boolean;
  calmMode: boolean;
  currentStep: RouteStep | null;
  nextStep: RouteStep | null;
  /** The maneuver after nextStep when it's a turn — drives the "then" chip. */
  followingStep: RouteStep | null;
  distanceToNext: number;
  distanceRemaining: number;
  timeRemaining: number;
  /** EMA-smoothed ground speed (m/s) — HUD readout + camera zoom. */
  speedMps: number;
  /** Ridden fraction of the route, 0–1 — the HUD progress bar. */
  progress: number;
  /** Battery saver: true when the dim overlay should cover the map. */
  dimmed: boolean;
  /** Chase-camera target, bumped each fix; null when not navigating. */
  camera: { center: LngLat; bearing: number; zoom: number; version: number } | null;
  /** The route currently being navigated (swapped on reroute). */
  activeRoute: RouteResponse | null;
}

interface Session {
  coords: LngLat[];
  steps: RouteStep[];
  stepArcs: number[];
  totalLen: number;
  durationS: number;
  /** The trip's FINAL destination. Kept for the resume record — navigation
   * itself never targets it except on the last leg. */
  to: LngLat;
  toLabel?: string;
  // ── Trip snapshot, taken at start() ───────────────────────────────────────
  // Reading live planner state mid-trip would let an edit corrupt leg indexing.
  /** Intermediate stops, in visiting order. */
  tripStops: Via[];
  /** Which leg we're on. Leg i ends at tripStops[i]; the last ends at `to`. */
  legIndex: number;
  /** Where the current leg ends — the only thing navigation ever targets. */
  legDestination: LngLat;
  legLabel: string | null;
  /** Epoch ms the ride began — the resume record's staleness clock. */
  startedAt: number;
  spokenPrepare: Set<number>;
  spokenNow: Set<number>;
  announced: Set<number>;
  lastStepIndex: number;
  offRouteSince: number | null;
  lastReroute: number;
  lastSpeed: number;
  phase: NavPhase;
  /** Last utterance timestamp — drives the long-straight reassurance prompt. */
  lastSpokenAt: number;
  /** EMA-smoothed speed for the camera/HUD (raw GPS speed jitters). */
  smoothedSpeed: number;
  /** Dim-overlay state machine (hysteresis lives here, not in render). */
  dimmed: boolean;
  /** Tap-to-wake: stay undimmed until this timestamp. */
  dimWakeUntil: number;
}

function speak(text: string, enabled: boolean) {
  if (!enabled || !text) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  window.speechSynthesis.speak(u);
}

/** Step's TTS clause, lowercase-first (server `spoken`, else the instruction). */
function clauseOf(step: RouteStep): string {
  const c = step.spoken ?? step.instruction;
  return c.charAt(0).toLowerCase() + c.slice(1);
}

function capFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Quiet-period + upcoming-turn gates for the reassurance prompt (mirrors iOS). */
const REASSURE_AFTER_MS = 120_000;
const REASSURE_MIN_AHEAD_M = 400;
/** A following maneuver within this distance chains into one prompt ("then immediately …"). */
const CHAIN_WITHIN_M = 40;
/** Battery-saver dim overlay: dim on long quiet straights, wake near turns
 * (hysteresis so it doesn't flicker at the boundary). Mirrors iOS. */
const DIM_AFTER_QUIET_MS = 20_000;
const DIM_BEYOND_M = 300;
const UNDIM_WITHIN_M = 220;
const DIM_TAP_WAKE_MS = 30_000;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Chase-camera zoom: pull back with speed, punch in near the turn. */
function navZoom(speedMps: number, distanceToNext: number): number {
  if (distanceToNext < 120) return 17.6;
  return clamp(17.6 - speedMps * 0.12, 16.3, 17.6);
}

/** Slice one leg out of an already-fetched multi-stop route: the coordinate span
 * `legs[i].coord_start…coord_end` plus the steps tagged with that `leg_index`.
 * Returns null when the route carries no leg breakdown (a plain A→B trip), so
 * callers fall back to the whole route unchanged. Mirrors iOS `legRoute`. */
function sliceLeg(route: RouteResponse, leg: number): RouteResponse | null {
  const legs: RouteLeg[] | undefined = route.legs;
  if (!legs || leg < 0 || leg >= legs.length) return null;
  const span = legs[leg];
  const coords = route.geometry.coordinates;
  if (
    span.coord_start < 0 ||
    span.coord_end >= coords.length ||
    span.coord_start >= span.coord_end
  ) {
    return null;
  }
  return {
    ...route,
    geometry: {
      type: "LineString",
      coordinates: coords.slice(span.coord_start, span.coord_end + 1),
    },
    steps: route.steps.filter((s) => s.leg_index === leg),
    distance_m: span.distance_m,
    duration_s: span.duration_s,
    greenway_coverage: span.greenway_coverage,
    legs: undefined,
  };
}

/** Where leg `i` ends, and what it's called. */
function legTarget(
  stops: Via[],
  end: LngLat,
  endLabel: string | undefined,
  leg: number
): { at: LngLat; label: string | null } {
  if (leg < stops.length) {
    return { at: stops[leg].at, label: stops[leg].label ?? null };
  }
  return { at: end, label: endLabel ?? null };
}

function toPlace(at: LngLat, label?: string | null): TripPlace {
  return { lat: at[1], lon: at[0], label: label ?? undefined };
}

/** The trip snapshot carried across every geometry swap within a session. */
type TripFields = Pick<
  Session,
  | "to"
  | "toLabel"
  | "tripStops"
  | "legIndex"
  | "legDestination"
  | "legLabel"
  | "startedAt"
>;

function tripOf(s: Session): TripFields {
  return {
    to: s.to,
    toLabel: s.toLabel,
    tripStops: s.tripStops,
    legIndex: s.legIndex,
    legDestination: s.legDestination,
    legLabel: s.legLabel,
    startedAt: s.startedAt,
  };
}

/** True when the current leg ends at the trip's final destination. */
function isFinalLeg(s: Session): boolean {
  return s.legIndex >= s.tripStops.length;
}

const INITIAL: NavView = {
  navigating: false,
  arrived: false,
  phase: "guiding",
  legLabel: null,
  nextLegLabel: null,
  legProgressLabel: null,
  showManualArrival: false,
  resumeFailed: false,
  rerouting: false,
  voiceEnabled: true,
  calmMode: false,
  currentStep: null,
  nextStep: null,
  followingStep: null,
  distanceToNext: 0,
  distanceRemaining: 0,
  timeRemaining: 0,
  speedMps: 0,
  progress: 0,
  dimmed: false,
  camera: null,
  activeRoute: null,
};

export function useNavigation() {
  const [view, setView] = useState<NavView>(INITIAL);
  const sessionRef = useRef<Session | null>(null);
  const watchId = useRef<number | null>(null);
  const cameraVersion = useRef(0);
  // Live-read toggles (kept in refs so the GPS callback isn't a stale closure).
  const voiceRef = useRef(true);
  const calmRef = useRef(false);

  // Last GPS fix, so Continue can re-route from where the rider is standing.
  const lastPos = useRef<LngLat | null>(null);

  // Keep the screen on only while actually guiding. Keyed on the phase, not on
  // `arrived` — a rider paused at a stop must not hold the wake lock for the
  // twenty minutes they're inside the shop.
  useWakeLock(view.navigating && view.phase === "guiding");

  /** Install a route as the thing being guided on, carrying trip state over. */
  const load = useCallback((route: RouteResponse, trip: TripFields) => {
    const coords = route.geometry.coordinates;
    sessionRef.current = {
      coords,
      steps: route.steps,
      stepArcs: computeStepArcs(route.steps, coords),
      totalLen: haversineLength(coords),
      durationS: route.duration_s,
      ...trip,
      spokenPrepare: new Set(),
      spokenNow: new Set(),
      announced: new Set(),
      lastStepIndex: -1,
      offRouteSince: null,
      lastReroute: 0,
      lastSpeed: 0,
      phase: "guiding",
      lastSpokenAt: Date.now(),
      smoothedSpeed: 0,
      dimmed: false,
      dimWakeUntil: 0,
    };
  }, []);

  /**
   * Recompute current → **this leg's** destination and keep guiding on it.
   *
   * No waypoints. With navigation scoped to a single leg there is nothing
   * downstream to thread through — which is what turns the old
   * `fetchRoute({ to: s.to })` (a bug that silently cancelled the rest of an
   * errand) into the correct call.
   */
  const reroute = useCallback(async (pos: LngLat) => {
    const s = sessionRef.current;
    if (!s) return;
    s.lastReroute = Date.now();
    s.lastSpokenAt = Date.now();
    setView((v) => ({ ...v, rerouting: true }));
    speak("Off route — rerouting.", voiceRef.current);
    try {
      const fresh = await fetchRoute({ from: pos, to: s.legDestination });
      if (fresh.geometry.coordinates.length >= 2 && sessionRef.current) {
        load(fresh, tripOf(s));
        setView((v) => ({ ...v, activeRoute: fresh, rerouting: false }));
        return;
      }
    } catch {
      /* keep guiding on the old line */
    }
    setView((v) => ({ ...v, rerouting: false }));
  }, [load]);

  const onPosition = useCallback(
    (pos: GeolocationPosition) => {
      const s = sessionRef.current;
      if (!s) return;
      const here: LngLat = [pos.coords.longitude, pos.coords.latitude];
      const speed = pos.coords.speed && pos.coords.speed > 0 ? pos.coords.speed : 0;
      s.lastSpeed = speed;
      s.smoothedSpeed = s.smoothedSpeed === 0 ? speed : s.smoothedSpeed * 0.7 + speed * 0.3;

      const arc = arcLengthAt(here, s.coords);
      const offRoute = distanceToPolyline(here, s.coords);
      const distanceRemaining = Math.max(0, s.totalLen - arc);
      const timeRemaining =
        s.durationS > 0 && s.totalLen > 0
          ? s.durationS * (distanceRemaining / s.totalLen)
          : 0;

      // Next maneuver = first step whose arc is meaningfully ahead of us.
      let idx = 0;
      while (idx < s.stepArcs.length && s.stepArcs[idx] <= arc + 2) idx++;
      const nextStep = idx < s.steps.length ? s.steps[idx] : null;
      const distanceToNext = nextStep ? Math.max(0, s.stepArcs[idx] - arc) : distanceRemaining;
      const currentIdx = Math.max(0, idx - 1);
      const currentStep = s.steps[currentIdx] ?? null;
      const followingStep =
        idx + 1 < s.steps.length && isTurn(s.steps[idx + 1].maneuver_type)
          ? s.steps[idx + 1]
          : null;
      const progress = s.totalLen > 0 ? clamp(arc / s.totalLen, 0, 1) : 0;

      // Camera: GPS heading while moving, else bearing along the route.
      let heading =
        typeof pos.coords.heading === "number" &&
        !Number.isNaN(pos.coords.heading) &&
        speed > 0.5
          ? pos.coords.heading
          : routeBearingAhead(here, s.coords);
      if (heading == null) heading = 0;
      cameraVersion.current += 1;

      lastPos.current = here;

      // Arrival — at this LEG's end. Intermediate stops get the more generous
      // radius; the final destination keeps the original 15 m.
      if (
        distanceRemaining <
        (isFinalLeg(s) ? ARRIVED_METERS : LEG_ARRIVED_METERS)
      ) {
        handleArrival(s, here, heading as number, currentStep);
        return;
      }

      announceStepEntry(s, currentIdx);
      evaluateVoice(s, idx, nextStep, distanceToNext);

      // Long-straight reassurance: quiet for a while, no turn coming up, still
      // on route → confirm the rider hasn't been forgotten. Calm mode skips it.
      if (
        !calmRef.current &&
        offRoute <= OFF_ROUTE_METERS &&
        distanceToNext > REASSURE_MIN_AHEAD_M &&
        Date.now() - s.lastSpokenAt > REASSURE_AFTER_MS
      ) {
        const street = currentStep?.street_name;
        say(
          s,
          street
            ? `Continue on ${street} for ${spokenDistanceBare(distanceToNext)}.`
            : `Continue for ${spokenDistanceBare(distanceToNext)}.`
        );
      }

      // Off-route → reroute (sustained + cooldown).
      if (offRoute > OFF_ROUTE_METERS) {
        if (s.offRouteSince == null) s.offRouteSince = Date.now();
        const offFor = Date.now() - s.offRouteSince;
        const sinceLast = Date.now() - s.lastReroute;
        if (offFor > 5000 && sinceLast > 15000) {
          void reroute(here);
        }
      } else {
        s.offRouteSince = null;
      }

      // Battery-saver dim, with hysteresis: dim on a long quiet straight,
      // wake approaching the turn, off-route, or within the tap-wake window.
      const now = Date.now();
      const wakeHeld = now < s.dimWakeUntil;
      if (s.dimmed) {
        if (distanceToNext < UNDIM_WITHIN_M || offRoute > OFF_ROUTE_METERS || wakeHeld) s.dimmed = false;
      } else if (
        !wakeHeld &&
        distanceToNext > DIM_BEYOND_M &&
        offRoute <= OFF_ROUTE_METERS &&
        now - s.lastSpokenAt > DIM_AFTER_QUIET_MS
      ) {
        s.dimmed = true;
      }

      setView((v) => ({
        ...v,
        currentStep,
        nextStep,
        followingStep,
        distanceToNext,
        distanceRemaining,
        timeRemaining,
        speedMps: s.smoothedSpeed,
        progress,
        dimmed: s.dimmed,
        // Backstop for locking up short of a stop, where the arrival radius
        // alone would never hand over a Continue button.
        showManualArrival:
          !isFinalLeg(s) && distanceRemaining < MANUAL_ARRIVAL_WITHIN_M,
        camera: {
          center: here,
          bearing: heading as number,
          zoom: navZoom(s.smoothedSpeed, distanceToNext),
          version: cameraVersion.current,
        },
      }));
    },
    [reroute]
  );

  /** Leg-derived fields for the view. */
  function legView(
    s: Session
  ): Pick<NavView, "legLabel" | "nextLegLabel" | "legProgressLabel"> {
    const next = legTarget(s.tripStops, s.to, s.toLabel, s.legIndex + 1);
    return {
      legLabel: s.legLabel,
      nextLegLabel: s.legIndex < s.tripStops.length ? next.label : null,
      legProgressLabel:
        s.tripStops.length === 0
          ? null
          : isFinalLeg(s)
            ? "Final leg"
            : `Stop ${s.legIndex + 1} of ${s.tripStops.length}`,
    };
  }

  /** Write the resume record. Only multi-stop trips have anything to resume. */
  function persist(s: Session) {
    if (s.tripStops.length === 0) return;
    saveTripProgress({
      version: CURRENT_VERSION,
      stops: s.tripStops.map((st) => toPlace(st.at, st.label)),
      end: toPlace(s.to, s.toLabel),
      legIndex: s.legIndex,
      startedAt: s.startedAt,
    });
  }

  /** Release the GPS watch — on a pause as much as on a teardown. */
  function releaseWatch() {
    if (watchId.current != null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
  }

  function acquireWatch() {
    if (watchId.current != null) return;
    watchId.current = navigator.geolocation.watchPosition(
      (p) => onPositionRef.current(p),
      () => {},
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 }
    );
  }

  /**
   * End of a leg. On the final leg this is the trip's terminal arrival; on any
   * other it is a *pause* — the GPS watch is released and the wake lock drops,
   * but the session stays alive so Continue can resume it.
   */
  function handleArrival(
    s: Session,
    here: LngLat,
    heading: number,
    currentStep: RouteStep | null
  ) {
    s.dimmed = false;
    if (isFinalLeg(s)) {
      if (s.phase !== "arrived") {
        s.phase = "arrived";
        speak("You've arrived. Enjoy the ride.", voiceRef.current);
        clearTripProgress();
        releaseWatch();
      }
    } else if (s.phase !== "pausedAtStop") {
      s.phase = "pausedAtStop";
      const at = s.legLabel ? `Arrived at ${s.legLabel}.` : "Arrived at your stop.";
      const next = legTarget(s.tripStops, s.to, s.toLabel, s.legIndex + 1).label;
      speak(
        next ? `${at} Continue to ${next} when you're ready.` : at,
        voiceRef.current
      );
      persist(s);
      releaseWatch();
    }
    setView((v) => ({
      ...v,
      phase: s.phase,
      arrived: s.phase === "arrived",
      ...legView(s),
      showManualArrival: false,
      currentStep,
      nextStep: null,
      followingStep: null,
      distanceToNext: 0,
      distanceRemaining: 0,
      timeRemaining: 0,
      progress: 1,
      dimmed: false,
      camera: {
        center: here,
        bearing: heading,
        zoom: navZoom(s.smoothedSpeed, 0),
        version: cameraVersion.current,
      },
    }));
  }

  // The GPS callback is re-created on every render; the watch is registered once
  // and reads through this ref so re-acquiring it (Continue) never has to depend
  // on the current closure.
  const onPositionRef = useRef(onPosition);
  useEffect(() => {
    onPositionRef.current = onPosition;
  }, [onPosition]);

  // Greenway-aware step-entry announcement.
  function announceStepEntry(s: Session, index: number) {
    if (index === s.lastStepIndex || s.announced.has(index)) return;
    s.lastStepIndex = index;
    s.announced.add(index);
    const step = s.steps[index];
    if (!step) return;
    const rank = protectionRank(step.bicycle_network_class);
    const prevRank = index > 0 ? protectionRank(s.steps[index - 1].bicycle_network_class) : rank;

    if (rank <= 1 && prevRank >= 2) {
      // Sum the exposed busy stretch.
      let exposed = 0;
      let i = index;
      while (i < s.steps.length && protectionRank(s.steps[i].bicycle_network_class) <= 1) {
        exposed += s.steps[i].distance_m;
        i++;
      }
      say(s, `Heads up — busy street for ${spokenDistanceBare(exposed)}, then back to the bikeway.`);
      return;
    }
    if (!calmRef.current && rank >= 3 && prevRank < 3 && !isTurn(step.maneuver_type)) {
      if (step.bicycle_network_class === "greenway" && step.street_name) {
        say(s, `Now on the ${step.street_name} greenway.`);
      } else if (step.bicycle_network_class === "protected" || step.bicycle_network_class === "off_street") {
        say(s, `Now on protected bike lane${step.street_name ? ` on ${step.street_name}` : ""}.`);
      }
    }
  }

  // Speak and stamp the session's quiet-period clock.
  function say(s: Session, text: string) {
    s.lastSpokenAt = Date.now();
    speak(text, voiceRef.current);
  }

  // Staged turn prompts ("prepare" then "now"), chaining back-to-back turns.
  function evaluateVoice(s: Session, idx: number, nextStep: RouteStep | null, distanceToNext: number) {
    if (!nextStep || !isTurn(nextStep.maneuver_type)) return;
    // A maneuver right after this turn joins the same prompt.
    const following = s.steps[idx + 1];
    const chained =
      nextStep.distance_m < CHAIN_WITHIN_M && following && isTurn(following.maneuver_type)
        ? following
        : null;
    const prepareAt = Math.min(220, Math.max(120, s.lastSpeed * 12 + 120));
    if (distanceToNext <= prepareAt && !s.spokenPrepare.has(idx)) {
      s.spokenPrepare.add(idx);
      say(s, `${spokenDistance(distanceToNext)}, ${clauseOf(nextStep)}`);
    }
    if (distanceToNext <= 30 && !s.spokenNow.has(idx)) {
      s.spokenNow.add(idx);
      let text = capFirst(clauseOf(nextStep));
      if (chained) {
        text += `, then immediately ${clauseOf(chained)}`;
        s.spokenPrepare.add(idx + 1); // its own prepare cue would be redundant
      }
      say(s, text);
    }
  }

  /**
   * Begin navigating. On a multi-stop trip this snapshots the stop list and
   * guides on **leg 0 only**, sliced out of the route the rider just reviewed —
   * no extra network call, and the line is exactly what they saw in the planner.
   * The map keeps showing the whole trip (matching iOS) until a reroute.
   */
  const start = useCallback(
    (
      route: RouteResponse,
      to: LngLat,
      opts?: { stops?: Via[]; toLabel?: string }
    ) => {
      if (!navigator.geolocation || route.geometry.coordinates.length < 2) return;
      const stops = opts?.stops ?? [];
      const target = legTarget(stops, to, opts?.toLabel, 0);
      const firstLeg = sliceLeg(route, 0) ?? route;
      load(firstLeg, {
        to,
        toLabel: opts?.toLabel,
        tripStops: stops,
        legIndex: 0,
        legDestination: target.at,
        legLabel: target.label,
        startedAt: Date.now(),
      });
      cameraVersion.current = 0;
      lastPos.current = null;
      const s = sessionRef.current!;
      persist(s);
      setView((v) => ({
        ...v,
        navigating: true,
        arrived: false,
        phase: "guiding",
        resumeFailed: false,
        rerouting: false,
        activeRoute: route,
        ...legView(s),
      }));
      // Prefer the synthesized "Head east on X" opener; else the first turn.
      const first = firstLeg.steps[0];
      const firstTurn = firstLeg.steps.find((st) => isTurn(st.maneuver_type));
      const opener =
        first && first.maneuver_type.startsWith("start")
          ? capFirst(clauseOf(first))
          : firstTurn?.instruction ?? "Follow the route.";
      speak(`Starting navigation. ${opener.replace(/\.?$/, ".")}`, voiceRef.current);
      acquireWatch();
    },
    [load]
  );

  /**
   * Continue to the next leg.
   *
   * Fetches a fresh route from wherever the rider is standing now rather than
   * slicing the next planned leg: after a long stop they're round the corner
   * from where that leg started, and a sliced line would begin metres away and
   * immediately trigger an off-route reroute.
   */
  const resume = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || s.phase !== "pausedAtStop" || isFinalLeg(s)) return;
    const from = lastPos.current;
    if (!from) {
      setView((v) => ({ ...v, resumeFailed: true }));
      return;
    }
    const nextLeg = s.legIndex + 1;
    const target = legTarget(s.tripStops, s.to, s.toLabel, nextLeg);
    setView((v) => ({ ...v, rerouting: true, resumeFailed: false }));
    try {
      const fresh = await fetchRoute({ from, to: target.at });
      if (fresh.geometry.coordinates.length >= 2) {
        load(fresh, {
          ...tripOf(s),
          legIndex: nextLeg,
          legDestination: target.at,
          legLabel: target.label,
        });
        const ns = sessionRef.current!;
        persist(ns);
        setView((v) => ({
          ...v,
          phase: "guiding",
          arrived: false,
          rerouting: false,
          resumeFailed: false,
          dimmed: false,
          activeRoute: fresh,
          ...legView(ns),
        }));
        speak(
          target.label ? `Continuing to ${target.label}.` : "Continuing.",
          voiceRef.current
        );
        acquireWatch();
        return;
      }
    } catch {
      /* stay paused and offer a retry — never strand the rider */
    }
    setView((v) => ({ ...v, rerouting: false, resumeFailed: true }));
  }, [load]);

  /** Skip the current stop without visiting it and carry on to the next leg. */
  const skipStop = useCallback(async () => {
    const s = sessionRef.current;
    if (!s || isFinalLeg(s)) return;
    if (s.phase === "guiding") s.phase = "pausedAtStop";
    await resume();
  }, [resume]);

  /** Manual "I'm here" — the rider declares arrival instead of waiting for the
   * radius, so stopping short of the stop can't leave them without a Continue. */
  const declareArrival = useCallback(() => {
    const s = sessionRef.current;
    if (!s || s.phase !== "guiding") return;
    handleArrival(s, lastPos.current ?? s.legDestination, 0, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stop = useCallback(() => {
    releaseWatch();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    sessionRef.current = null;
    lastPos.current = null;
    clearTripProgress();
    setView(INITIAL);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setVoiceEnabled = useCallback((on: boolean) => {
    voiceRef.current = on;
    if (!on && typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    setView((v) => ({ ...v, voiceEnabled: on }));
  }, []);

  const setCalmMode = useCallback((on: boolean) => {
    calmRef.current = on;
    setView((v) => ({ ...v, calmMode: on }));
  }, []);

  /** Tap-to-wake from the battery-saver dim overlay. */
  const wake = useCallback(() => {
    const s = sessionRef.current;
    if (s) {
      s.dimWakeUntil = Date.now() + DIM_TAP_WAKE_MS;
      s.dimmed = false;
    }
    setView((v) => ({ ...v, dimmed: false }));
  }, []);

  useEffect(() => () => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  return {
    ...view,
    start,
    stop,
    resume,
    skipStop,
    declareArrival,
    setVoiceEnabled,
    setCalmMode,
    wake,
  };
}
