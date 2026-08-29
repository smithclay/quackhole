# Builds crates/quackhole-core (iroh + tokio) as a Rust static library and
# exposes it as the imported target `quackhole::core`.
#
# Adapted from duckdb-otlp/cmake/FindOtlp2Records.cmake, which learned most of
# these lessons the hard way.

# The crates share one workspace, so build output and the lockfile live at the
# workspace root rather than beside the crate.
set(QUACKHOLE_WORKSPACE_DIR "${CMAKE_CURRENT_SOURCE_DIR}/crates")
set(QUACKHOLE_CORE_DIR "${QUACKHOLE_WORKSPACE_DIR}/quackhole-core")

if(NOT EXISTS "${QUACKHOLE_CORE_DIR}/Cargo.toml")
  message(FATAL_ERROR "quackhole-core not found at ${QUACKHOLE_CORE_DIR}")
endif()

find_program(CARGO_EXECUTABLE cargo REQUIRED)

# --- Target triple -----------------------------------------------------------
# cargo needs an explicit --target so the output path is predictable, and so
# cross-compilation (notably macOS arm64 <-> x86_64 in CI) actually crosses.
if(CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  if(CMAKE_OSX_ARCHITECTURES MATCHES "x86_64")
    set(QUACKHOLE_RUST_TARGET "x86_64-apple-darwin")
  elseif(CMAKE_OSX_ARCHITECTURES MATCHES "arm64")
    set(QUACKHOLE_RUST_TARGET "aarch64-apple-darwin")
  elseif(CMAKE_HOST_SYSTEM_PROCESSOR STREQUAL "arm64")
    set(QUACKHOLE_RUST_TARGET "aarch64-apple-darwin")
  else()
    set(QUACKHOLE_RUST_TARGET "x86_64-apple-darwin")
  endif()
elseif(WIN32)
  set(QUACKHOLE_RUST_TARGET "x86_64-pc-windows-msvc")
elseif(CMAKE_SYSTEM_PROCESSOR MATCHES "aarch64|arm64")
  set(QUACKHOLE_RUST_TARGET "aarch64-unknown-linux-gnu")
else()
  set(QUACKHOLE_RUST_TARGET "x86_64-unknown-linux-gnu")
endif()

if(CMAKE_BUILD_TYPE STREQUAL "Debug")
  set(QUACKHOLE_CARGO_PROFILE_DIR "debug")
  set(QUACKHOLE_CARGO_FLAGS "")
else()
  set(QUACKHOLE_CARGO_PROFILE_DIR "release")
  set(QUACKHOLE_CARGO_FLAGS "--release")
endif()

if(WIN32)
  set(QUACKHOLE_LIB_NAME "quackhole_core.lib")
else()
  set(QUACKHOLE_LIB_NAME "libquackhole_core.a")
endif()

set(QUACKHOLE_LIB_PATH
    "${QUACKHOLE_WORKSPACE_DIR}/target/${QUACKHOLE_RUST_TARGET}/${QUACKHOLE_CARGO_PROFILE_DIR}/${QUACKHOLE_LIB_NAME}"
)

# --- Build rule --------------------------------------------------------------
# DEPENDS matters: an add_custom_command without it only re-runs when OUTPUT is
# missing, so editing a .rs file would silently relink a stale archive.
#
# Cargo.lock is listed too, so `cargo update` forces a relink. (It must exist;
# ninja fails with "missing and no known rule to make it" for an absent DEPENDS.)
file(GLOB_RECURSE QUACKHOLE_RUST_SOURCES CONFIGURE_DEPENDS
     "${QUACKHOLE_CORE_DIR}/src/*.rs")

add_custom_command(
  OUTPUT ${QUACKHOLE_LIB_PATH}
  COMMAND ${CARGO_EXECUTABLE} build ${QUACKHOLE_CARGO_FLAGS} --target
          ${QUACKHOLE_RUST_TARGET}
  DEPENDS ${QUACKHOLE_RUST_SOURCES} "${QUACKHOLE_CORE_DIR}/Cargo.toml"
          "${QUACKHOLE_WORKSPACE_DIR}/Cargo.lock"
  WORKING_DIRECTORY ${QUACKHOLE_CORE_DIR}
  COMMENT "Building quackhole-core (${QUACKHOLE_CARGO_PROFILE_DIR}, ${QUACKHOLE_RUST_TARGET})"
  VERBATIM)

add_custom_target(quackhole_core_build DEPENDS ${QUACKHOLE_LIB_PATH})

add_library(quackhole::core STATIC IMPORTED GLOBAL)
set_target_properties(
  quackhole::core PROPERTIES IMPORTED_LOCATION ${QUACKHOLE_LIB_PATH}
                             INTERFACE_INCLUDE_DIRECTORIES
                             "${QUACKHOLE_CORE_DIR}/include")
add_dependencies(quackhole::core quackhole_core_build)

# --- System libraries a Rust staticlib expects the consumer to provide -------
if(WIN32)
  set_property(
    TARGET quackhole::core
    APPEND
    PROPERTY INTERFACE_LINK_LIBRARIES ws2_32 userenv bcrypt ntdll advapi32)
elseif(APPLE)
  set_property(
    TARGET quackhole::core
    APPEND
    PROPERTY INTERFACE_LINK_LIBRARIES "-framework Security"
             "-framework CoreFoundation" "-framework SystemConfiguration")
else()
  set_property(
    TARGET quackhole::core
    APPEND
    PROPERTY INTERFACE_LINK_LIBRARIES pthread dl m)
endif()
