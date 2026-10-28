# syntax=docker/dockerfile:1.7
# HardHub engine: KiCad 10 + Freerouting + the hardhub Python package, as an
# HTTP service on port 8080.  One recipe for both kinds of computer: native
# arm64 on an Apple Silicon Mac (no Rosetta), amd64 as a Cloudflare Container
# (unprivileged, listens on 8080).  Docker builds for the computer it runs
# on unless told otherwise, and picks the matching download of each part.
#
#   docker build -t hardhub-engine engine                          # this computer
#   docker build --platform linux/amd64 -t hardhub-engine engine   # Cloudflare's
#
# KiCad comes from the KiCad team's own Ubuntu packages (their Docker images
# are amd64 only).  Every other download is pinned to an exact stable release
# and checked against its published sha256.

# The downloads that differ by processor (TARGETARCH: amd64 or arm64, set by
# Docker), each checked against its sha256:
# Java 25 (Eclipse Temurin, the version Freerouting 2.5 is built and shipped
# with) and Node 22 LTS for gltf-transform
FROM scratch AS downloads-amd64
ADD --checksum=sha256:1731a34baadec5479258ea0202e4d5d865d2efeee60cb0c7d7eb056fe96ca219 \
    https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_x64_linux_hotspot_25.0.4.1_1.tar.gz /jre.tar.gz
ADD --checksum=sha256:df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de \
    https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz /node.tar.xz

FROM scratch AS downloads-arm64
ADD --checksum=sha256:34828cbb93ed31c281c84ecb31ddab655d11a802f263c1fc019d42e9e0230fed \
    https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_aarch64_linux_hotspot_25.0.4.1_1.tar.gz /jre.tar.gz
ADD --checksum=sha256:a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f \
    https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-arm64.tar.xz /node.tar.xz

FROM downloads-${TARGETARCH} AS downloads

# Ubuntu 24.04 LTS, pinned by digest (the digest covers both processors)
FROM ubuntu:24.04@sha256:24737cef17f4e22b1977df7d9a05e77c4e28b7da5b8911f8d8ccda136bf3573c

ARG WITH_TESTS=0

# KiCad 10.0.7 from the KiCad team's PPA (amd64 and arm64 builds of the same
# release), read through Launchpad's snapshot of it on a fixed date so the
# same packages install every time.  The PPA's signing key is in this folder
# and must match the fingerprint Launchpad publishes for it.  Only the
# symbols, footprints and templates: the full 3D library is 5 GB, the few
# folders the viewer needs come below.  xvfb gives Freerouting 1.9 its display;
# librsvg (with cairo) turns view_board's SVGs into PNGs.
ARG KICAD_VERSION=10.0.7~ubuntu24.04.1
ARG KICAD_PPA_SNAPSHOT=20261027T000000Z
ARG KICAD_PPA_KEY=FDA854F61C4D0D9572BB95E5245D5502FAD7A805
COPY kicad-ppa.asc /tmp/kicad-ppa.asc
RUN apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates gnupg > /dev/null \
 && gpg --show-keys --with-colons /tmp/kicad-ppa.asc | grep -q "^fpr:*$KICAD_PPA_KEY:" \
 && gpg --dearmor < /tmp/kicad-ppa.asc > /usr/share/keyrings/kicad.gpg \
 && echo "deb [signed-by=/usr/share/keyrings/kicad.gpg] https://snapshot.ppa.launchpadcontent.net/kicad/kicad-10.0-releases/ubuntu/$KICAD_PPA_SNAPSHOT noble main" \
      > /etc/apt/sources.list.d/kicad.list \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      kicad=$KICAD_VERSION kicad-symbols=$KICAD_VERSION kicad-footprints=$KICAD_VERSION kicad-templates=$KICAD_VERSION \
      python3 git xz-utils xvfb xauth librsvg2-2 > /dev/null \
 && apt-get purge -y -qq gnupg > /dev/null && apt-get autoremove -y -qq > /dev/null \
 && rm -rf /var/lib/apt/lists/* /tmp/kicad-ppa.asc \
 && kicad-cli version && python3 -c "import pcbnew; print('pcbnew', pcbnew.GetBuildVersion())" \
 && useradd --create-home --shell /usr/sbin/nologin kicad

# pip (Ubuntu's Python ships without it), from PyPI
ADD --checksum=sha256:71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e \
    https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-26.2.1-py3-none-any.whl \
    /tmp/pip-26.2.1-py3-none-any.whl
RUN python3 /tmp/pip-26.2.1-py3-none-any.whl/pip install --break-system-packages --no-cache-dir -q /tmp/pip-26.2.1-py3-none-any.whl \
 && rm /tmp/pip-26.2.1-py3-none-any.whl

# Java for both Freerouting versions
RUN --mount=from=downloads,target=/dl \
    mkdir -p /opt/jre && tar -xzf /dl/jre.tar.gz -C /opt/jre --strip-components=1 \
 && ln -s /opt/jre/bin/java /usr/local/bin/java && java -version

# 3D models (STEP) of the common KiCad standard footprints, for the GLB the
# web viewer shows: only these folders, from KiCad's own library at the
# release matching KiCad 10.0.7, checked against the release's commit
ARG KICAD_3D_COMMIT=8d4070daa0fa3f7a7f3c176f4ca7bffc4df392be
RUN git clone -q --depth 1 --branch 10.0.7 --filter=blob:none --sparse https://gitlab.com/kicad/libraries/kicad-packages3D.git /tmp/p3d \
 && cd /tmp/p3d && test "$(git rev-parse HEAD)" = "$KICAD_3D_COMMIT" \
 && git sparse-checkout set --no-cone $(for d in Resistor_SMD Capacitor_SMD Inductor_SMD LED_SMD Diode_SMD Package_TO_SOT_SMD \
        Package_SO Package_DFN_QFN Connector_USB Connector_PinHeader_2.54mm Connector_JST Button_Switch_SMD \
        RF_Module Crystal Fuse Sensor_Humidity Connector_BarrelJack TerminalBlock_Phoenix; do echo "/$d.3dshapes/*.step"; done) \
 && mkdir -p /usr/share/kicad/3dmodels && cp -r /tmp/p3d/*.3dshapes /usr/share/kicad/3dmodels/ \
 && rm -rf /tmp/p3d
ENV KICAD10_3DMODEL_DIR=/usr/share/kicad/3dmodels

# Freerouting 2.5.0 (the primary router: headless, multi-threaded) and 1.9.0
# (the fallback), as the release jars GitHub publishes, with their sha256.
# 2.5's jar is the one its Linux bundle carries (same build, same classes);
# the bundle itself is x64 only, so it runs on the Java above instead, with
# the bundle's own Java options
ADD --checksum=sha256:f6f51bb02245e8e717f9359bd260cc9c5c0b1bc0acc8b7cb2cd5b8ffeb5de3c7 \
    https://github.com/freerouting/freerouting/releases/download/v2.5.0/freerouting-2.5.0.jar /opt/freerouting-2.5.0.jar
ADD --checksum=sha256:9084a4888937a7f31f857ecc12aa7a37407f51160e4d2892dff9c9bb47ae3102 \
    https://github.com/freerouting/freerouting/releases/download/v1.9.0/freerouting-1.9.0.jar /opt/freerouting-1.9.0.jar
RUN printf '#!/bin/sh\nexec java -Djpackage.app-version=2.5.0 -Dlog4j2.disableJndi=true -jar /opt/freerouting-2.5.0.jar "$@"\n' \
      > /usr/local/bin/freerouting && chmod a+rx /usr/local/bin/freerouting /opt/freerouting-2.5.0.jar /opt/freerouting-1.9.0.jar

# Node 22 LTS for gltf-transform (meshopt-compresses the board's GLB)
RUN --mount=from=downloads,target=/dl \
    mkdir -p /opt/node && tar -xJf /dl/node.tar.xz -C /opt/node --strip-components=1
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
    FREEROUTING_JAR=/opt/freerouting-1.9.0.jar FREEROUTING2=/usr/local/bin/freerouting \
    FREEROUTING_TIMEOUT=900 HARDHUB_BUILD_TIMEOUT=1800

USER kicad
WORKDIR /opt/hardhub
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s \
  CMD python3 -c "import urllib.request as u,sys; sys.exit(0 if u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8080/health', timeout=8).status == 200 else 1)"
CMD ["python3", "-m", "hardhub.server"]
