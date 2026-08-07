/**
 * dataAttribution.ts
 *
 * Reads bike-network.manifest.json so the credits footer names every agency
 * whose data is actually loaded, with the date it was received.
 *
 * WHY THE DATE MATTERS: Metro's RLIS Limited Use License requires derivative
 * products to display the attribution string AND the date the data was received
 * from Metro. Hardcoding that date in JSX guarantees it goes stale on the next
 * export, so it is read from the manifest the exporter writes (`fetchedAt`).
 *
 * Failure here must never break the app — a missing manifest degrades to the
 * static OSM/PBOT credit that shipped before the metro expansion.
 */

export interface AttributionEntry {
  id: string;
  attribution: string;
  attributionUrl: string;
  fetchedAt: string;
}

interface ManifestEntry extends AttributionEntry {
  file: string;
  features: number;
}

let cached: AttributionEntry[] | null = null;

export async function loadAttributions(): Promise<AttributionEntry[]> {
  if (cached) return cached;
  try {
    const res = await fetch("/bike-network.manifest.json");
    if (!res.ok) return [];
    const manifest = (await res.json()) as ManifestEntry[];
    cached = manifest
      .filter((m) => m.attribution)
      .map(({ id, attribution, attributionUrl, fetchedAt }) => ({
        id,
        attribution,
        attributionUrl,
        fetchedAt,
      }));
    return cached;
  } catch {
    return [];
  }
}
