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

# Nothing below depends on Debian's package servers except the optional
# display for the fallback router: every other download is an exact release
# checked against its published sha256 (or, for KiCad's 3D models, a git
# commit), so the image builds the same on any network.

# pip (the KiCad image ships Python without it), from PyPI
ADD --checksum=sha256:71138adf1f4ca900cdb7d289c21b7494329f2332b6d85f0e1c42108c0384ed3e \
    https://files.pythonhosted.org/packages/f3/6e/1736e5b4ae2b778ef2f81c47d797de9f891d4d8acb047a24ca37a60294dd/pip-26.2.1-py3-none-any.whl \
    /tmp/pip-26.2.1-py3-none-any.whl
RUN python3 /tmp/pip-26.2.1-py3-none-any.whl/pip install --break-system-packages --no-cache-dir -q /tmp/pip-26.2.1-py3-none-any.whl \
 && rm /tmp/pip-26.2.1-py3-none-any.whl

# Java 21 (Eclipse Temurin) for Freerouting 1.9, the fallback router;
# 2.5, the primary, brings its own runtime
ADD --checksum=sha256:aeab55d064a1a27a3744b0880b9b414077b4ed2b1790817eea3df60aec946431 \
    https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.9%2B10/OpenJDK21U-jre_x64_linux_hotspot_21.0.9_10.tar.gz \
    /tmp/jre.tar.gz
RUN mkdir -p /opt/jre && tar -xzf /tmp/jre.tar.gz -C /opt/jre --strip-components=1 && rm /tmp/jre.tar.gz \
 && ln -s /opt/jre/bin/java /usr/local/bin/java

# Freerouting 1.9 needs a display even in batch mode. Optional: when the
# Debian mirror is unreachable the build goes on, and the engine routes with
# 2.5 alone (GET /health says which routers it has).
RUN (apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xvfb xauth > /dev/null \
     && echo "xvfb installed: Freerouting 1.9 available as the fallback router") \
    || echo "xvfb not installed (no Debian mirror): Freerouting 2.5 only"; \
    rm -rf /var/lib/apt/lists/*

# 3D models (STEP) of the common KiCad standard footprints, for the GLB the
# web viewer shows: only these folders, from KiCad's own library at the
# release matching KiCad 10.0.6, checked against the release's commit
ARG KICAD_3D_COMMIT=e62ed1fc7862da83f789bd562671b5e4b82afcdf
RUN git clone -q --depth 1 --branch 10.0.6 --filter=blob:none --sparse https://gitlab.com/kicad/libraries/kicad-packages3D.git /tmp/p3d \
 && cd /tmp/p3d && test "$(git rev-parse HEAD)" = "$KICAD_3D_COMMIT" \
 && git sparse-checkout set --no-cone $(for d in Resistor_SMD Capacitor_SMD Inductor_SMD LED_SMD Diode_SMD Package_TO_SOT_SMD \
        Package_SO Package_DFN_QFN Connector_USB Connector_PinHeader_2.54mm Connector_JST Button_Switch_SMD \
        RF_Module Crystal Fuse Sensor_Humidity; do echo "/$d.3dshapes/*.step"; done) \
 && mkdir -p /usr/share/kicad/3dmodels && cp -r /tmp/p3d/*.3dshapes /usr/share/kicad/3dmodels/ \
 && rm -rf /tmp/p3d
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

# Node 22 LTS for gltf-transform (meshopt-compresses the board's GLB);
# Python unpacks it because the image has no xz
ADD --checksum=sha256:df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de \
    https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz /tmp/node.tar.xz
RUN python3 -c "import tarfile; tarfile.open('/tmp/node.tar.xz').extractall('/opt', filter='data')" \
 && mv /opt/node-v22.23.3-linux-x64 /opt/node && rm /tmp/node.tar.xz
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
  CMD python3 -c "import urllib.request as u,sys; sys.exit(0 if u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:8080/health', timeout=8).status == 200 else 1)"
CMD ["python3", "-m", "hardhub.server"]
