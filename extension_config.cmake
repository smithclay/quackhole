# This file is included by DuckDB's build system. It specifies which extension to load

# Extension from this repo
duckdb_extension_load(quackhole
    SOURCE_DIR ${CMAKE_CURRENT_LIST_DIR}
    LOAD_TESTS
)

# httpfs is NOT built into this tree. Since DuckDB 1.5 it lives out-of-tree
# (duckdb/duckdb-httpfs), and community-extensions builds do not vendor it
# either. QuackholeHTTPUtil auto-loads it at runtime instead
# (ExtensionHelper::TryAutoLoadExtension in quackhole_http.cpp), which is also
# how Quack gets it -- DuckDB's built-in HTTPLibClient::Post throws
# NotImplementedException, so something must provide a real HTTP client.
