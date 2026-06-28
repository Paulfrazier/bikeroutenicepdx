# BRouter routing engine for BikeRouteNicePDX — SELF-BUILD tile variant.
#
# Identical RouteServer to brouter-service/, but instead of curl-ing stock tiles
# from brouter.de it serves the locally self-built segment tiles committed in
# segments4/ — built by scripts/build-brouter-tiles.sh with the Phase-1 OSM-gap
# backlog (PBOT facilities + contraflow) + SRTM1 elevation baked in.
#
# Runs as a SECOND Railway service alongside the stock `brouter` service so the
# app can A/B prod-vs-selfbuild routing (POST /route { engine: "selfbuild" }).
# See docs/BROUTER_SELF_BUILD.md.
FROM eclipse-temurin:21-jre

WORKDIR /brouter

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# BRouter release (jar + stock profiles2/). Pin v1.7.9 to match the lookups.dat
# the tiles were built against.
RUN curl -fsSL -o brouter.zip \
      https://github.com/abrensch/brouter/releases/download/v1.7.9/brouter-1.7.9.zip \
    && unzip -q brouter.zip \
    && rm brouter.zip

# Self-built segment tiles (committed in segments4/ on the default branch).
# FETCHED FROM GITHUB AT BUILD TIME rather than uploaded as build context: the
# ~15 MB of .rd5 tiles rarely change, and re-uploading them on every `railway up`
# made deploys time out on slow uplinks (15 MB / ~440 KB/s ~= 36 s > CLI timeout).
# They're excluded from the upload via .railwayignore, so `railway up` ships ~90 KB.
# Pinned to `main`; the uploaded lookups.dat below MUST match the lookups the tiles
# on main were built against (both kept in sync on main).
RUN mkdir -p segments4 customprofiles \
    && curl -fSL https://raw.githubusercontent.com/Paulfrazier/bikeroutenicepdx/main/brouter-service-selfbuild/segments4/W125_N45.rd5 -o segments4/W125_N45.rd5 \
    && curl -fSL https://raw.githubusercontent.com/Paulfrazier/bikeroutenicepdx/main/brouter-service-selfbuild/segments4/W125_N40.rd5 -o segments4/W125_N40.rd5

# Custom profiles (the app's "Ultra" + "Comfort" tiers). UNLIKE the stock service
# these DIVERGE from brouter-service/profiles/ — they carry the weaklane penalty,
# which reads cycleway:*:buffer (only decodable on self-build tiles).
COPY profiles/safety-ultra.brf brouter-1.7.9/profiles2/safety-ultra.brf
COPY profiles/safety-comfort.brf brouter-1.7.9/profiles2/safety-comfort.brf

# CRITICAL: serve with the SAME lookups.dat the tiles were BUILT against
# (scripts/build-brouter-tiles.sh). It adds cycleway:*:buffer over stock v1.7.9;
# a mismatch silently misdecodes tags. Overrides the stock file from the zip.
COPY profiles/lookups.dat brouter-1.7.9/profiles2/lookups.dat

# Railway injects $PORT. Args: <segmentdir> <profiledir> <customprofiledir> <port> <maxthreads>
ENV PORT=17777
CMD ["sh", "-c", "java -Xmx512m -cp brouter-1.7.9/brouter-1.7.9-all.jar btools.server.RouteServer segments4 brouter-1.7.9/profiles2 customprofiles ${PORT} 1"]
