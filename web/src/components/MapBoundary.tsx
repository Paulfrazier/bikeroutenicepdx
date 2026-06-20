/**
 * MapBoundary.tsx — error boundary around the map canvas.
 *
 * MapLibre throws if it can't get a WebGL context (old GPUs, hardware-accel off,
 * headless browsers). Without a boundary that throw unmounts the entire React
 * tree and the whole app goes blank. This keeps the failure local: the rest of
 * the UI (inputs, route summary, tour) stays alive and the map slot shows a
 * friendly fallback instead.
 */

import { Component, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { failed: boolean };

export class MapBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    // Surface for diagnostics; the UI fallback handles the user-facing side.
    console.error("Map failed to render:", error);
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="map-fallback" role="alert">
          <div className="map-fallback__icon" aria-hidden="true">
            🗺️
          </div>
          <p className="map-fallback__title">The map couldn't load</p>
          <p className="map-fallback__body">
            Your browser may have WebGL disabled or unsupported. Try enabling
            hardware acceleration, or open the app in a different browser.
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}
