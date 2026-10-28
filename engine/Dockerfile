# syntax=docker/dockerfile:1.7
# HardHub engine: KiCad 10 + Freerouting + the hardhub Python package, as an
# HTTP service on port 8080.  The same image runs on a Mac (Docker Desktop,
# under Rosetta: KiCad publishes amd64 images only) and as a Cloudflare
# Container (amd64, unprivileged, listens on 8080).
#
#   docker build --platform linux/amd64 -t hardhub-engine engine
#   docker run --rm -p 8080:8080 hardhub-engine
#
# Every download is pinned to an exact stable release and checked against
# its published sha256.

# KiCad 10.0.6, the newest stable image Docker Hub has (10.0.7 has no image
# yet), pinned by digest as offgrid-hardware's boards are
FROM --platform=linux/amd64 kicad/kicad:10.0.6@sha256:18693567392b80da435f9fa952ce3a3e534c66eb5a6033f5b9c80aa3b19dd3ec

USER root
ARG WITH_TESTS=0

# xvfb: Freerouting 1.9 (the fallback router) needs a display even in batch
# mode.  Java 21 runs it; 2.5 brings its own runtime.
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      python3-pip openjdk-21-jre-headless xvfb xauth ngspice xz-utils ca-certificates > /dev/null \
 && rm -rf /var/lib/apt/lists/*

# 3D models of the common KiCad standard footprints, for the GLB the web
# viewer shows: only these folders of Debian's kicad-packages3d (apt checks
# the package against its signed index)
RUN cd /tmp && apt-get update -qq && apt-get download -qq kicad-packages3d \
 && for d in Resistor_SMD Capacitor_SMD Inductor_SMD LED_SMD Diode_SMD Package_TO_SOT_SMD Package_SO \
             Package_DFN_QFN Connector_USB Connector_PinHeader_2.54mm Connector_JST Button_Switch_SMD \
             RF_Module Crystal Fuse Sensor_Humidity; do \
      dpkg-deb --fsys-tarfile kicad-packages3d_*.deb | tar -x -C / --wildcards "./usr/share/kicad/3dmodels/$d.3dshapes/*"; \
    done \
 && rm kicad-packages3d_*.deb && rm -rf /var/lib/apt/lists/*
ENV KICAD10_3DMODEL_DIR=/usr/share/kicad/3dmodels

# Freerouting 2.5.0 (the primary router: headless, multi-threaded) as its
# official Linux bundle, and 1.9.0 as the fallback; sha256 as GitHub
# publishes them
ADD --checksum=sha256:e8ffca14914e5307a2fa9aea723fb93d11b99bebda20d126472da5460c03196e \
    https://github.com/freerouting/freerouting/releases/download/v2.5.0/freerouting-2.5.0-linux-x64.zip /opt/
ADD --checksum=sha256:9084a4888937a7f31f857ecc12aa7a37407f51160e4d2892dff9c9bb47ae3102 \
    https://github.com/freerouting/freerouting/releases/download/v1.9.0/freerouting-1.9.0.jar /opt/freerouting-1.9.0.jar
RUN cd /opt && python3 -m zipfile -e freerouting-2.5.0-linux-x64.zip . && rm freerouting-2.5.0-linux-x64.zip \
 && chmod -R a+rx /opt/freerouting-2.5.0-linux-x64 /opt/freerouting-1.9.0.jar

# Node 22 LTS for gltf-transform (meshopt-compresses the board's GLB)
ADD --checksum=sha256:df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de \
    https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz /tmp/node.tar.xz
RUN mkdir -p /opt/node && tar -xJf /tmp/node.tar.xz -C /opt/node --strip-components=1 && rm /tmp/node.tar.xz
COPY tools/gltf/package.json tools/gltf/package-lock.json /opt/gltf/
RUN cd /opt/gltf && PATH=/opt/node/bin:$PATH npm ci --ignore-scripts --no-audit --no-fund --omit=dev \
 && ln -s /opt/gltf/node_modules/.bin/gltf-transform /usr/local/bin/gltf-transform

COPY requirements.txt requirements-test.txt /opt/hardhub/
RUN pip3 install --break-system-packages --no-cache-dir -q -r /opt/hardhub/requirements.txt \
 && if [ "$WITH_TESTS" = "1" ]; then pip3 install --break-system-packages --no-cache-dir -q -r /opt/hardhub/requirements-test.txt; fi

COPY hardhub /opt/hardhub/hardhub
COPY tests /opt/hardhub/tests

RUN mkdir -p /var/lib/hardhub/jobs /var/cache/hardhub && chown -R kicad:kicad /var/lib/hardhub /var/cache/hardhub

ENV PATH=/opt/node/bin:$PATH \
    PYTHONPATH=/opt/hardhub PYTHONHASHSEED=0 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    HOME=/tmp PORT=8080 \
    HARDHUB_JOBS=/var/lib/hardhub/jobs HARDHUB_FP_CACHE=/var/cache/hardhub HARDHUB_MAX_BUILDS=1 \
    FREEROUTING_JAR=/opt/freerouting-1.9.0.jar FREEROUTING2=/opt/freerouting-2.5.0-linux-x64/bin/freerouting \
    FREEROUTING_TIMEOUT=900 HARDHUB_BUILD_TIMEOUT=1800

USER kicad
WORKDIR /opt/hardhub
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=8).status == 200 else 1)"
CMD ["python3", "-m", "hardhub.server"]
