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

# Self-built segment tiles (committed): W125_N45 (Portland metro) + W125_N40
# (southern buffer). Drop-in replacement for the brouter.de download — same
# filenames, same RouteServer.
RUN mkdir -p segments4 customprofiles
COPY segments4/W125_N45.rd5 segments4/W125_N45.rd5
COPY segments4/W125_N40.rd5 segments4/W125_N40.rd5

# Custom profiles (the app's "Ultra" + "Comfort" tiers), same as the stock service.
COPY profiles/safety-ultra.brf brouter-1.7.9/profiles2/safety-ultra.brf
COPY profiles/safety-comfort.brf brouter-1.7.9/profiles2/safety-comfort.brf

# Railway injects $PORT. Args: <segmentdir> <profiledir> <customprofiledir> <port> <maxthreads>
ENV PORT=17777
CMD ["sh", "-c", "java -Xmx512m -cp brouter-1.7.9/brouter-1.7.9-all.jar btools.server.RouteServer segments4 brouter-1.7.9/profiles2 customprofiles ${PORT} 1"]
