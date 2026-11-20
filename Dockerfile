# syntax=docker/dockerfile:1.7
# Riosoma: one image runs the web app and the API, and a second runs the connector service, which
# holds the database drivers the server doesn't carry.  `docker build .` builds the server image, and
# `docker build --target connectors .` the connector service's.  Build from a checkout that has the
# theme assets fetched by tools/release/fetch-theme-assets.mjs, since fonts and textures are not in git.

FROM mirror.gcr.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
RUN npm install -g pnpm@11.22.0 --no-audit --no-fund
WORKDIR /src
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm fetch
COPY . .
COPY themes/ ./themes/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --offline --frozen-lockfile
ARG RIOSOMA_LOCALES=en-US
RUN pnpm turbo run build --filter=@riosoma/server... --filter=@riosoma/web --filter=@riosoma/connector-service...
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @riosoma/server deploy --prod --legacy /out/server
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @riosoma/connector-service deploy --prod --legacy /out/connectors
# Only what the app serves: stylesheets, manifests, and assets.
RUN mkdir -p /out/themes && cp themes/index.json /out/themes/ \
 && for d in themes/*/; do n=$(basename "$d"); mkdir -p "/out/themes/$n"; cp "$d"theme.css "$d"theme.json "/out/themes/$n/"; \
      if [ -d "$d"assets ]; then cp -R "$d"assets "/out/themes/$n/"; fi; done \
 && mkdir -p /out/config /out/connector-token

# IBM's client loads these libraries at runtime.  Keep their Debian release aligned with distroless.
FROM mirror.gcr.io/library/debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS driver-libraries
# Distroless lags Debian security for zlib.  Remove this overlay once the pinned distroless
# digest ships zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1 or later.
RUN apt-get update && apt-get install -y --no-install-recommends \
      -o 'Dpkg::Options::=--path-include=/usr/share/doc/zlib1g/*' \
      libxml2 libpam0g libcrypt1 libaudit1 libeconf0 libcap-ng0 liblzma5 zlib1g \
 && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' zlib1g)" ge '1:1.3.dfsg+really1.3.1-1+deb13u1' \
 && md5sum -c "/var/lib/dpkg/info/zlib1g:$(dpkg --print-architecture).md5sums" \
 && mkdir -p /out/zlib/var/lib/dpkg/status.d \
 && dpkg-query -L zlib1g | while IFS= read -r file; do \
      if [ -f "$file" ] || [ -L "$file" ]; then cp -a --parents "$file" /out/zlib/; fi; \
    done \
 && dpkg-query -s zlib1g > /out/zlib/var/lib/dpkg/status.d/zlib1g \
 && cp "/var/lib/dpkg/info/zlib1g:$(dpkg --print-architecture).md5sums" /out/zlib/var/lib/dpkg/status.d/zlib1g.md5sums \
 && mkdir -p /out/lib \
 && for library in libxml2.so.2 libpam.so.0 libcrypt.so.1 libaudit.so.1 libeconf.so.0 libcap-ng.so.0 liblzma.so.5 libz.so.1; do \
      location=$(find /usr/lib -name "$library" -print -quit); test -n "$location"; cp -L "$location" /out/lib/; \
    done

# The connector service: the drivers for MySQL, SQL Server, Oracle, Firebird, Snowflake, BigQuery,
# Databricks, ClickHouse, and MongoDB, behind a small API only the server calls.  It keeps no shell,
# package manager, or system tools either, and publishes no port of its own.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS connectors
ARG RIOSOMA_VERSION=0.95.0-rc.1
# The token comes from the file the server writes into storage both mount, unless it's set outright.
ENV NODE_ENV=production \
    RIOSOMA_VERSION=${RIOSOMA_VERSION} \
    RIOSOMA_CONNECTOR_SERVICE_HOST=0.0.0.0 \
    RIOSOMA_CONNECTOR_SERVICE_PORT=8091 \
    RIOSOMA_CONNECTOR_SERVICE_TOKEN_FILE=/connector-token/token
WORKDIR /app/connectors
COPY --from=driver-libraries /out/zlib/ /
COPY --from=build --chown=nonroot:nonroot /out/connectors /app/connectors
COPY --from=build --chown=nonroot:nonroot /out/connector-token /connector-token
USER nonroot
EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8091/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["dist/main.js"]

# The runtime keeps no shell, package manager, or system tools.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e AS runtime
# The release this image was built from, reported by /healthz.
ARG RIOSOMA_VERSION=0.95.0-rc.1
# The connector service image built with this one, by digest, which the one-click updater reads to
# update the connector service along with Riosoma.  Empty in a local build.
ARG RIOSOMA_CONNECTORS_DIGEST=
LABEL io.riosoma.connectors.digest=${RIOSOMA_CONNECTORS_DIGEST}
ENV NODE_ENV=production \
    RIOSOMA_VERSION=${RIOSOMA_VERSION} \
    RIOSOMA_WEB_DIR=/app/web \
    RIOSOMA_THEMES_DIR=/app/themes \
    RIOSOMA_CONFIG_DIR=/config \
    RIOSOMA_PORT=8080
WORKDIR /app/server
COPY --from=driver-libraries /out/lib/ /usr/lib/
COPY --from=driver-libraries /out/zlib/ /
COPY --from=build --chown=nonroot:nonroot /out/server /app/server
COPY --from=build --chown=nonroot:nonroot /src/apps/web/dist /app/web
COPY --from=build --chown=nonroot:nonroot /out/themes /app/themes
# The updater sidecar for Compose runs from this image with its own command.
COPY --from=build --chown=nonroot:nonroot /src/deploy/updater /app/updater
COPY --from=build --chown=nonroot:nonroot /out/config /config
# Where Compose mounts the storage the server writes the connector service's token into
COPY --from=build --chown=nonroot:nonroot /out/connector-token /connector-token
USER nonroot
VOLUME ["/config"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["dist/main.js"]
