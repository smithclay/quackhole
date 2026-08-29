# syntax=docker/dockerfile:1.7
#
# One image, two roles. The server and the client run the same DuckDB build --
# what differs is the network they are attached to and the script they run.
#
# The extension is compiled here rather than copied from the host: the host is
# macOS/arm64 and the containers are Linux, and cross-compiling a DuckDB
# loadable extension is more trouble than a cached image layer.

# ---------------------------------------------------------------- build stage
FROM debian:bookworm AS build

RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential cmake ninja-build git curl ca-certificates python3 \
    && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain stable
ENV PATH=/root/.cargo/bin:$PATH

WORKDIR /src
COPY . /src

# .dockerignore strips every .git, so `git describe` cannot work. DuckDB's own
# release CI uses this same escape hatch; the version string has to be a real
# release or INSTALL cannot find matching extension binaries.
ENV GEN=ninja \
    OVERRIDE_GIT_DESCRIBE=v1.5.4 \
    ENABLE_EXTENSION_AUTOLOADING=1 \
    ENABLE_EXTENSION_AUTOINSTALL=1 \
    EXT_FLAGS=-DBUILD_UNITTESTS=0 \
    CMAKE_BUILD_PARALLEL_LEVEL=6

RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    make release

# Bake the extensions in, so the test itself does not depend on
# extensions.duckdb.org being reachable -- the only traffic we want to be
# testing is iroh's.
RUN ./build/release/duckdb -c "INSTALL httpfs;" \
 && (./build/release/duckdb -c "INSTALL quack;" \
     || ./build/release/duckdb -c "INSTALL quack FROM community;")

# -------------------------------------------------------------- runtime stage
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl libstdc++6 \
      iproute2 iptables iputils-ping netcat-openbsd procps \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /src/build/release/duckdb /usr/local/bin/duckdb
COPY --from=build /root/.duckdb /root/.duckdb
COPY test/docker/lib.sh test/docker/server.sh test/docker/client.sh /opt/qh/

RUN chmod +x /opt/qh/*.sh
WORKDIR /opt/qh
