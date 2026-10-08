FROM ghcr.io/ivo-toby/talond:latest

ARG BUILD_VERSION
ARG BUILD_ARCH

LABEL \
  io.hass.version="$BUILD_VERSION" \
  io.hass.type="app" \
  io.hass.arch="$BUILD_ARCH"

USER root
RUN curl -fsSL https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64 \
      -o /usr/local/bin/ttyd \
    && chmod 0755 /usr/local/bin/ttyd

COPY ingress-proxy.cjs /usr/local/lib/talon-ingress-proxy.cjs
COPY run.sh /run.sh
COPY talonctl /usr/local/bin/talonctl
RUN chmod 0755 /run.sh /usr/local/bin/talonctl && mkdir -p /data/talon

ENTRYPOINT ["/usr/bin/tini", "--", "/run.sh"]
