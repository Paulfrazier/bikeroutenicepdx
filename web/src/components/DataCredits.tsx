/**
 * DataCredits — the "Route data:" line in the side-panel footer.
 *
 * OSM and PBOT are static because they were always there. Everything else comes
 * from bike-network.manifest.json, so adding a jurisdiction to
 * scripts/lib/jurisdictions.ts credits it automatically rather than relying on
 * someone remembering to edit this file.
 *
 * Metro's RLIS license requires its attribution string verbatim AND the date the
 * data was received, so agencies that declare one render as "© Oregon Metro
 * (RLIS, 2026-08-06)".
 */

import { useEffect, useState } from "react";
import { loadAttributions, type AttributionEntry } from "../dataAttribution";

export function DataCredits() {
  const [entries, setEntries] = useState<AttributionEntry[]>([]);

  useEffect(() => {
    let alive = true;
    loadAttributions().then((e) => {
      if (alive) setEntries(e);
    });
    return () => {
      alive = false;
    };
  }, []);

  // PBOT is credited statically below, so don't credit it twice.
  const extra = entries.filter((e) => e.id !== "portland");

  return (
    <small>
      Route data:{" "}
      <a href="https://openstreetmap.org" target="_blank" rel="noopener noreferrer">
        OSM
      </a>{" "}
      (ODbL) ·{" "}
      <a
        href="https://www.portland.gov/transportation"
        target="_blank"
        rel="noopener noreferrer"
      >
        PBOT
      </a>
      {extra.map((e) => (
        <span key={e.id}>
          {" · "}
          <a href={e.attributionUrl} target="_blank" rel="noopener noreferrer">
            {e.attribution}
          </a>
          {e.fetchedAt ? ` (${e.fetchedAt})` : ""}
        </span>
      ))}
    </small>
  );
}
