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

# Custom profiles. safety-ultra backs the "Ultra" tier; safety-comfort backs the
# "Comfort" tier (stock safety.brf + a maxspeed penalty). Both sit in profiles2/
# alongside the stock profiles so `profile=safety-ultra` / `profile=safety-comfort`
# resolve the same way `profile=safety` does.
COPY profiles/safety-ultra.brf brouter-1.7.9/profiles2/safety-ultra.brf
COPY profiles/safety-comfort.brf brouter-1.7.9/profiles2/safety-comfort.brf

# Railway injects $PORT. RouteServer binds the given port on all interfaces.
# Args: <segmentdir> <profiledir> <customprofiledir> <port> <maxthreads>
ENV PORT=17777
# Memory tuning. Railway bills RAM per MB/minute and this service is idle almost
# all the time, so the JVM's *idle* footprint is the whole cost — not its peak.
# Default G1 grows the heap and never hands it back, which parked the container
# at ~270 MB around the clock. SerialGC is the right collector here anyway (the
# RouteServer runs with maxthreads=1) and, with the free-ratio pair below, it
# shrinks the heap back to the OS after each route instead of holding the
# high-water mark. -Xmx stays generous so a long cross-town search still fits.
CMD ["sh", "-c", "java -Xms32m -Xmx384m -XX:+UseSerialGC -XX:MaxMetaspaceSize=96m -XX:MinHeapFreeRatio=10 -XX:MaxHeapFreeRatio=25 -XX:-UsePerfData -cp brouter-1.7.9/brouter-1.7.9-all.jar btools.server.RouteServer segments4 brouter-1.7.9/profiles2 customprofiles ${PORT} 1"]
