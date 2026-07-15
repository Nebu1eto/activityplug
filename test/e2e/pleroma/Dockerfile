# syntax=docker/dockerfile:1.23@sha256:2780b5c3bab67f1f76c781860de469442999ed1a0d7992a5efdf2cffc0e3d769

ARG ELIXIR_IMAGE=hexpm/elixir:1.17.3-erlang-27.3.4.14-alpine-3.23.5@sha256:6c4154d0ebab6ca2e4f4aa003d9267821ef6d3e962aebfc025581b5ed83338b1
ARG RUNTIME_IMAGE=alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40

FROM ${ELIXIR_IMAGE} AS build

ARG SOURCE_REF
ENV HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt
ENV MIX_ENV=prod
ENV VIX_COMPILATION_MODE=PLATFORM_PROVIDED_LIBVIPS
WORKDIR /source

COPY --from=pleroma_source . .

# The project-owned bootstrap keeps trust rooted in the current CA bundle and
# pins both Mix installers instead of depending on a mutable development image.
RUN apk add --no-cache \
      ca-certificates=20260611-r0 \
      cmake=4.1.3-r0 \
      curl=8.20.0-r0 \
      file-dev=5.46-r2 \
      g++=15.2.0-r2 \
      gcc=15.2.0-r2 \
      git=2.52.0-r0 \
      make=4.4.1-r3 \
      musl-dev=1.2.5-r23 \
      vips-dev=8.17.3-r1 && \
    update-ca-certificates && \
    mix local.hex 2.5.1 --force && \
    curl --fail --location --proto '=https' --tlsv1.2 \
      --output /tmp/rebar3 \
      https://github.com/erlang/rebar3/releases/download/3.27.0/rebar3 && \
    echo 'af85aab41f9fd74bdd6341ebdf6fe9c88077aab9f8eac82371583fa02f2b0bdf  /tmp/rebar3' | sha256sum -c - && \
    mix local.rebar rebar3 /tmp/rebar3 --force && \
    rm /tmp/rebar3

RUN echo 'import Config' > config/prod.secret.exs && \
    mix deps.clean --all && \
    mix deps.get --only prod && \
    mix release --path /release

FROM ${RUNTIME_IMAGE} AS runtime

ARG SOURCE_REF
ARG HOME=/opt/pleroma
ARG DATA=/var/lib/pleroma

LABEL org.opencontainers.image.revision=${SOURCE_REF}

RUN apk add --no-cache \
      ca-certificates=20260611-r0 \
      exiftool=13.55-r0 \
      ffmpeg=8.0.1-r1 \
      libmagic=5.46-r2 \
      ncurses=6.5_p20251123-r0 \
      postgresql18-client=18.4-r0 \
      vips=8.17.3-r1 && \
    adduser --system --shell /bin/false --home ${HOME} pleroma && \
    mkdir -p ${DATA}/uploads ${DATA}/static /etc/pleroma && \
    chown -R pleroma ${DATA} /etc/pleroma

USER pleroma

COPY --from=build --chown=pleroma:0 /release ${HOME}
COPY --from=build --chown=pleroma:0 --chmod=640 \
  /source/config/docker.exs /etc/pleroma/config.exs
COPY --from=build --chown=pleroma:0 --chmod=755 \
  /source/docker-entrypoint.sh ${HOME}/docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["/opt/pleroma/docker-entrypoint.sh"]
