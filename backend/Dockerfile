FROM elixir:1.14.1-alpine AS build

# install build dependencies
RUN \
  apk add --no-cache \
  build-base \
  npm \
  git \
  python3 \
  make \
  cmake \
  openssl-dev \ 
  libsrtp-dev \
  ffmpeg-dev \
  clang-dev

ARG DASHBOARD_AUTH_USERNAME
ENV DASHBOARD_AUTH_USERNAME=${DASHBOARD_AUTH_USERNAME}

ARG DASHBOARD_AUTH_PASSWORD
ENV DASHBOARD_AUTH_PASSWORD=${DASHBOARD_AUTH_PASSWORD}

ENV PHX_SERVER=TRUE

# Create build workdir
WORKDIR /app

# install hex + rebar
RUN mix local.hex --force && \
  mix local.rebar --force

# set build ENV
ENV MIX_ENV=prod

# install mix dependencies
COPY mix.exs mix.lock ./
COPY config config
COPY priv priv
# the lib code must be there first so the tailwindcss can properly inspect the code
# to gather necessary classes to generate
COPY lib lib

RUN mix setup
RUN mix deps.compile

# compile and build release

RUN mix do compile, release

# prepare release image
FROM alpine:3.16 AS app

# install runtime dependencies
RUN \
  apk add --no-cache \
  openssl \
  ncurses-libs \
  libsrtp \
  ffmpeg \
  clang \ 
  curl

WORKDIR /app

RUN chown nobody:nobody /app

USER nobody:nobody

COPY --from=build --chown=nobody:nobody /app/_build/prod/rel/free4chat ./

ENV HOME=/app

EXPOSE 4000

HEALTHCHECK CMD curl --fail http://localhost:4000/api/healthcheck || exit 1  

CMD ["bin/free4chat", "start"]
