ARG NODE_IMAGE
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
RUN pnpm -r --filter @activityplug/example-web-client... --sort build
RUN pnpm --filter @activityplug/example-web-client build:server
RUN pnpm --filter @activityplug/example-web-client deploy --prod --legacy /out
RUN ACTIVITYPLUG_STORAGE=memory \
    ACTIVITYPLUG_PUBLIC_ORIGIN=https://localhost \
    ACTIVITYPLUG_TRUSTED_PROXY_ADDRESSES=127.0.0.1 \
    ACTIVITYPLUG_COOKIE_SIGNING_KEY=MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI \
    ACTIVITYPLUG_ALLOWED_REMOTE_ORIGINS=https://mastodon.example \
    node /out/dist/server/server.js & server_pid=$!; \
    trap 'kill "$server_pid"' EXIT; \
    for attempt in 1 2 3 4 5; do \
      node -e "fetch('http://127.0.0.1:4000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))" \
        && exit_code=0 && break; \
      exit_code=1; sleep 1; \
    done; \
    test "$exit_code" -eq 0

FROM ${NODE_IMAGE}
ARG NODE_IMAGE
RUN printf '%s' "$NODE_IMAGE" | grep -Eq '.+@sha256:[0-9a-f]{64}$'
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=node:node --from=build /out ./
USER node
HEALTHCHECK --interval=5s --timeout=3s --retries=12 --start-period=5s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:4000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "dist/server/server.js"]
