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
import type { LngLat, RouteResponse, RouteStep } from "../types";
import { fetchRoute } from "../api";
import { useWakeLock } from "./useWakeLock";
import { haversineLength, arcLengthAt } from "../geo";
import {
  distanceToPolyline,
  computeStepArcs,
  routeBearingAhead,
  protectionRank,
  isTurn,
  spokenDistance,
  spokenDistanceBare,
} from "../navigation";

export interface NavView {
  navigating: boolean;
  arrived: boolean;
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
  to: LngLat;
  spokenPrepare: Set<number>;
  spokenNow: Set<number>;
  announced: Set<number>;
  lastStepIndex: number;
  offRouteSince: number | null;
  lastReroute: number;
  lastSpeed: number;
  arrived: boolean;
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

const INITIAL: NavView = {
  navigating: false,
  arrived: false,
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

  // Keep the screen on for the duration of the ride.
  useWakeLock(view.navigating && !view.arrived);

  const load = useCallback((route: RouteResponse, to: LngLat) => {
    const coords = route.geometry.coordinates;
    sessionRef.current = {
      coords,
      steps: route.steps,
      stepArcs: computeStepArcs(route.steps, coords),
      totalLen: haversineLength(coords),
      durationS: route.duration_s,
      to,
      spokenPrepare: new Set(),
      spokenNow: new Set(),
      announced: new Set(),
      lastStepIndex: -1,
      offRouteSince: null,
      lastReroute: 0,
      lastSpeed: 0,
      arrived: false,
      lastSpokenAt: Date.now(),
      smoothedSpeed: 0,
      dimmed: false,
      dimWakeUntil: 0,
    };
  }, []);

  const reroute = useCallback(async (pos: LngLat) => {
    const s = sessionRef.current;
    if (!s) return;
    s.lastReroute = Date.now();
    s.lastSpokenAt = Date.now();
    setView((v) => ({ ...v, rerouting: true }));
    speak("Off route — rerouting.", voiceRef.current);
    try {
      const fresh = await fetchRoute({ from: pos, to: s.to });
      if (fresh.geometry.coordinates.length >= 2 && sessionRef.current) {
        load(fresh, s.to);
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

      // Arrival.
      if (distanceRemaining < 15) {
        if (!s.arrived) {
          s.arrived = true;
          speak("You've arrived. Enjoy the ride.", voiceRef.current);
        }
        s.dimmed = false;
        setView((v) => ({
          ...v,
          arrived: true,
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
            bearing: heading as number,
            zoom: navZoom(s.smoothedSpeed, 0),
            version: cameraVersion.current,
          },
        }));
        return;
      }

      announceStepEntry(s, currentIdx);
      evaluateVoice(s, idx, nextStep, distanceToNext);

      // Long-straight reassurance: quiet for a while, no turn coming up, still
      // on route → confirm the rider hasn't been forgotten. Calm mode skips it.
      if (
        !calmRef.current &&
        offRoute <= 30 &&
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
      if (offRoute > 30) {
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
        if (distanceToNext < UNDIM_WITHIN_M || offRoute > 30 || wakeHeld) s.dimmed = false;
      } else if (
        !wakeHeld &&
        distanceToNext > DIM_BEYOND_M &&
        offRoute <= 30 &&
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

  const start = useCallback(
    (route: RouteResponse, to: LngLat) => {
      if (!navigator.geolocation || route.geometry.coordinates.length < 2) return;
      load(route, to);
      cameraVersion.current = 0;
      setView((v) => ({ ...v, navigating: true, arrived: false, rerouting: false, activeRoute: route }));
      // Prefer the synthesized "Head east on X" opener; else the first turn.
      const first = route.steps[0];
      const firstTurn = route.steps.find((s) => isTurn(s.maneuver_type));
      const opener =
        first && first.maneuver_type.startsWith("start")
          ? capFirst(clauseOf(first))
          : firstTurn?.instruction ?? "Follow the route.";
      speak(`Starting navigation. ${opener.replace(/\.?$/, ".")}`, voiceRef.current);
      watchId.current = navigator.geolocation.watchPosition(onPosition, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 1000,
        timeout: 20000,
      });
    },
    [load, onPosition]
  );

  const stop = useCallback(() => {
    if (watchId.current != null) {
      navigator.geolocation.clearWatch(watchId.current);
      watchId.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    sessionRef.current = null;
    setView(INITIAL);
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

  return { ...view, start, stop, setVoiceEnabled, setCalmMode, wake };
}
