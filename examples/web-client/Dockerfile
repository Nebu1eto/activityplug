ARG NODE_IMAGE
ARG CADDY_IMAGE
ARG PNPM_VERSION

FROM ${NODE_IMAGE} AS build
ARG NODE_IMAGE
ARG PNPM_VERSION
WORKDIR /workspace
RUN printf '%s' "$NODE_IMAGE" | grep -Eq '.+@sha256:[0-9a-f]{64}$' \
  && test -n "$PNPM_VERSION" \
  && npm install --global "pnpm@${PNPM_VERSION}"
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml rolldown.config.ts tsconfig.base.json ./
COPY packages ./packages
COPY examples/web-client ./examples/web-client
RUN pnpm install --frozen-lockfile
# The Vite build loads the dev-server plugin, which imports workspace packages
# through their built `dist` entries, so the dependency graph must build first.
RUN pnpm -r --filter @activityplug/example-web-client... --sort build
RUN pnpm --filter @activityplug/example-web-client build

FROM ${CADDY_IMAGE}
ARG CADDY_IMAGE
RUN printf '%s' "$CADDY_IMAGE" | grep -Eq '.+@sha256:[0-9a-f]{64}$' \
  && addgroup -S activityplug \
  && adduser -S -D -H -G activityplug activityplug \
  && mkdir -p /data /config /srv \
  && chown -R activityplug:activityplug /data /config /srv /etc/caddy
COPY --chown=activityplug:activityplug examples/web-client/Caddyfile /etc/caddy/Caddyfile
COPY --chown=activityplug:activityplug --from=build /workspace/examples/web-client/dist /srv
RUN CADDY_HOST=example.invalid caddy adapt --validate --config /etc/caddy/Caddyfile --adapter caddyfile
USER activityplug
HEALTHCHECK --interval=5s --timeout=3s --retries=12 --start-period=5s \
  CMD wget --no-check-certificate --quiet --spider --header="Host: ${CADDY_HOST}" \
  https://127.0.0.1/health || exit 1
