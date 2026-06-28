# BikeRouteNicePDX — iOS App Privacy ("nutrition label")

Source of truth for the **App Store Connect → App Privacy** questionnaire (the
"nutrition label" shown on the listing and required for TestFlight external
testing). Re-verify before each TestFlight/App Store submission.

The app has **no analytics or crash SDK bundled**. It is a thin client over our
own routing server. The only off-device data flows are (1) the coordinates/search
text you send to our server to get a route, and (2) PII-stripped performance
telemetry our *server* sends to New Relic. Both are declared below.

---

## Bundled privacy manifest — `BikeRouteNicePDX/PrivacyInfo.xcprivacy`

`NSPrivacyCollectedDataTypes` is **empty, and stays empty.** The manifest declares
data collected by the app and any third-party SDKs *bundled in the app*. New Relic
runs only on the server — there is no New Relic SDK in the app — so it does not
belong in the manifest. The manifest's `NSPrivacyAccessedAPITypes` entry
(`UserDefaults`, reason `CA92.1`) is unchanged.

The App Store Connect nutrition label below is broader than the manifest: it also
covers data our server and third parties collect on our behalf, which is why
Diagnostics appears there but not in the manifest.

---

## App Store Connect answers

### Location
- **Collected:** Yes — *Precise Location* (and/or *Coarse Location*).
- **Purpose:** App Functionality (computing the bicycle route you request).
- **Linked to your identity:** No (no accounts; coordinates are used to compute the
  route and are not stored or associated with you).
- **Used for tracking:** No.
- **Notes:** Sent to our routing server only to fulfill a route request. Excluded
  from the New Relic telemetry described below (request bodies are not captured).

### Diagnostics → Performance Data
- **Collected:** Yes.
- **Purpose:** App Functionality (monitoring and improving routing-server
  reliability and latency).
- **Linked to your identity:** No.
- **Used for tracking:** No.
- **Third parties that receive this data:** New Relic.
- **Notes:** Server-side only. Our backend sends operational telemetry (response
  times, error rates, request throughput) to New Relic. The agent is configured to
  **exclude all PII** — no IP address, no search text, no coordinates, no request
  contents. Config: `server/newrelic.cjs` (`attributes.exclude` strips
  `request.uri`, headers, params, and body; `application_logging.forwarding`
  disabled). No New Relic code runs in the app.

### Everything else
- **Not collected:** Contact info, identifiers, usage data, purchases, browsing
  history, search history (the search query is sent to the geocoder to fulfill the
  request and is not retained by us; New Relic does not receive it), crash data
  (no in-app crash SDK).

### Tracking
- The app does **not** track. `NSPrivacyTracking` is `false`;
  `NSPrivacyTrackingDomains` is empty.

---

## Third parties (for the data-flow record)

| Party | What it receives | Privacy policy |
|-------|------------------|----------------|
| Our routing server (Frazier Ideas LLC) | Start/end coordinates, search text, to compute routes | web/public/privacy.html |
| New Relic | Server performance telemetry, **PII stripped** | https://newrelic.com/termsandconditions/privacy |
| OpenStreetMap / Nominatim / Photon / OpenFreeMap / PBOT | Geocoding queries + map-tile requests (IP visible as normal web traffic) | their own policies |

Keep this in sync with the web policy at `web/public/privacy.html` (§3 Server
Performance Monitoring) and the server config at `server/newrelic.cjs`.
