# BRouter routing engine for BikeRouteNicePDX.
# Greenway-preferring bike routing — beats Valhalla ~2x on greenway coverage
# because BRouter reads OSM lcn route relations and penalizes non-bike roads.
#
# Self-contained: downloads the BRouter release (jar + stock profiles) and the
# Portland-region segment tile at build time. No tile build, small footprint.
FROM eclipse-temurin:21-jre

WORKDIR /brouter

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# BRouter release (jar + profiles2/)
RUN curl -fsSL -o brouter.zip \
      https://github.com/abrensch/brouter/releases/download/v1.7.9/brouter-1.7.9.zip \
    && unzip -q brouter.zip \
    && rm brouter.zip

# Portland-region segment (W125_N45 covers lon -125..-120, lat 45..50)
RUN mkdir -p segments4 customprofiles \
    && curl -fsSL -o segments4/W125_N45.rd5 \
       https://brouter.de/brouter/segments4/W125_N45.rd5

# Railway injects $PORT. RouteServer binds the given port on all interfaces.
# Args: <segmentdir> <profiledir> <customprofiledir> <port> <maxthreads>
ENV PORT=17777
CMD ["sh", "-c", "java -Xmx512m -cp brouter-1.7.9/brouter-1.7.9-all.jar btools.server.RouteServer segments4 brouter-1.7.9/profiles2 customprofiles ${PORT} 1"]
