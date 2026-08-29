cmake_minimum_required(VERSION 3.5)

# Set extension name here
set(TARGET_NAME quackhole)

# NOTE: the template's `find_package(OpenSSL REQUIRED)` is deliberately absent.
# Quackhole speaks no TLS of its own -- iroh's QUIC connection is the encryption
# layer. OpenSSL stays in vcpkg.json only because httpfs (loaded from
# extension_config.cmake) needs it.

set(EXTENSION_NAME ${TARGET_NAME}_extension)
set(LOADABLE_EXTENSION_NAME ${TARGET_NAME}_loadable_extension)

project(${TARGET_NAME})

set(CMAKE_CXX_STANDARD "17" CACHE STRING "C++ standard to enforce")
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include_directories(src/include)

set(EXTENSION_SOURCES
    src/quackhole_extension.cpp
    src/quackhole_http.cpp
    src/quackhole_state.cpp)

# The iroh transport lives in a Rust static library linked in over a C ABI.
# This extension itself is an ordinary C++ DuckDB extension.
list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
include(FindQuackholeCore)

build_static_extension(${TARGET_NAME} ${EXTENSION_SOURCES})
build_loadable_extension(${TARGET_NAME} " " ${EXTENSION_SOURCES})

# Link the Rust core into BOTH targets. Linking only the static one yields a
# build that passes tests and a loadable extension that fails at dlopen.
target_link_libraries(${EXTENSION_NAME} quackhole::core)
target_link_libraries(${LOADABLE_EXTENSION_NAME} quackhole::core)

install(
  TARGETS ${EXTENSION_NAME}
  EXPORT "${DUCKDB_EXPORT_SET}"
  LIBRARY DESTINATION "${INSTALL_LIB_DIR}"
  ARCHIVE DESTINATION "${INSTALL_LIB_DIR}")
