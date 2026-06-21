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
  distanceToNext: number;
  distanceRemaining: number;
  timeRemaining: number;
  /** Chase-camera target, bumped each fix; null when not navigating. */
  camera: { center: LngLat; bearing: number; version: number } | null;
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
}

function speak(text: string, enabled: boolean) {
  if (!enabled || !text) return;
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = "en-US";
  window.speechSynthesis.speak(u);
}

const INITIAL: NavView = {
  navigating: false,
  arrived: false,
  rerouting: false,
  voiceEnabled: true,
  calmMode: false,
  currentStep: null,
  nextStep: null,
  distanceToNext: 0,
  distanceRemaining: 0,
  timeRemaining: 0,
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
    };
  }, []);

  const reroute = useCallback(async (pos: LngLat) => {
    const s = sessionRef.current;
    if (!s) return;
    s.lastReroute = Date.now();
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
        setView((v) => ({
          ...v,
          arrived: true,
          currentStep,
          nextStep: null,
          distanceToNext: 0,
          distanceRemaining: 0,
          timeRemaining: 0,
          camera: { center: here, bearing: heading as number, version: cameraVersion.current },
        }));
        return;
      }

      announceStepEntry(s, currentIdx);
      evaluateVoice(s, idx, nextStep, distanceToNext);

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

      setView((v) => ({
        ...v,
        currentStep,
        nextStep,
        distanceToNext,
        distanceRemaining,
        timeRemaining,
        camera: { center: here, bearing: heading as number, version: cameraVersion.current },
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
      speak(`Heads up — busy street for ${spokenDistanceBare(exposed)}, then back to the bikeway.`, voiceRef.current);
      return;
    }
    if (!calmRef.current && rank >= 3 && prevRank < 3 && !isTurn(step.maneuver_type)) {
      if (step.bicycle_network_class === "greenway" && step.street_name) {
        speak(`Now on the ${step.street_name} greenway.`, voiceRef.current);
      } else if (step.bicycle_network_class === "protected" || step.bicycle_network_class === "off_street") {
        speak(`Now on protected bike lane${step.street_name ? ` on ${step.street_name}` : ""}.`, voiceRef.current);
      }
    }
  }

  // Staged turn prompts ("prepare" then "now").
  function evaluateVoice(s: Session, idx: number, nextStep: RouteStep | null, distanceToNext: number) {
    if (!nextStep || !isTurn(nextStep.maneuver_type)) return;
    const prepareAt = Math.min(220, Math.max(120, s.lastSpeed * 12 + 120));
    if (distanceToNext <= prepareAt && !s.spokenPrepare.has(idx)) {
      s.spokenPrepare.add(idx);
      const lead = nextStep.instruction;
      speak(`${spokenDistance(distanceToNext)}, ${lead.charAt(0).toLowerCase()}${lead.slice(1)}`, voiceRef.current);
    }
    if (distanceToNext <= 30 && !s.spokenNow.has(idx)) {
      s.spokenNow.add(idx);
      speak(nextStep.instruction, voiceRef.current);
    }
  }

  const start = useCallback(
    (route: RouteResponse, to: LngLat) => {
      if (!navigator.geolocation || route.geometry.coordinates.length < 2) return;
      load(route, to);
      cameraVersion.current = 0;
      setView((v) => ({ ...v, navigating: true, arrived: false, rerouting: false, activeRoute: route }));
      const firstTurn = route.steps.find((s) => isTurn(s.maneuver_type));
      speak(`Starting navigation. ${firstTurn?.instruction ?? "Follow the route."}`, voiceRef.current);
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

  useEffect(() => () => {
    if (watchId.current != null) navigator.geolocation.clearWatch(watchId.current);
  }, []);

  return { ...view, start, stop, setVoiceEnabled, setCalmMode };
}
