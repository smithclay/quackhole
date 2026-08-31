#pragma once

#include "duckdb/main/database.hpp"
#include "duckdb/storage/storage_extension.hpp"

#include <mutex>

struct QhCore;

namespace duckdb {

//! NOT a real storage/ATTACH backend: this StorageExtension implements no
//! attach, transaction or catalog semantics. It is only the standard DuckDB hook
//! for hanging per-DatabaseInstance state off DBConfig, keyed by
//! STORAGE_EXTENSION_KEY. What we need from it is its destructor, which fires on
//! database close -- that is where the tokio runtime and iroh endpoint get shut
//! down. Do not repurpose this as an actual storage backend.
class QuackholeStorageExtension : public StorageExtension {
public:
	QuackholeStorageExtension();
};

class QuackholeState : public StorageExtensionInfo {
public:
	static constexpr const char *STORAGE_EXTENSION_KEY = "quackhole_state";

	//! Shuts the core down. Runs on DatabaseInstance teardown.
	~QuackholeState() override;

	//! Install the state hook on this database. Idempotent.
	static void Register(DatabaseInstance &db);
	//! Throws if the extension was not loaded on this database.
	static QuackholeState &Get(DatabaseInstance &db);

	//! Bind the iroh endpoint if it is not bound yet, and return the core.
	//! `key_path` and `relays` are ignored once a core exists -- the endpoint id
	//! is the address and the relay map is chosen at bind, so neither can change
	//! under a running session.
	QhCore *GetOrCreateCore(const string &key_path, bool ephemeral, const string &relays);
	//! The core if one has been created, else nullptr. Never binds.
	QhCore *TryGetCore();

	//! Default key location: <home>/.quackhole/key
	static string DefaultKeyPath(DatabaseInstance &db);

	//! The `quackhole_relays` setting: relay URLs separated by commas or
	//! whitespace, empty for n0's public relays. Parsed by the core, so this
	//! only reads it. Public because quackhole_serve()'s `ephemeral := true`
	//! path builds a core without going through the settings below, and both
	//! paths have to home on the same relays.
	static string RelaysFromSettings(DatabaseInstance &db);

	//! Create the core using the `quackhole_key_path` / `quackhole_ephemeral`
	//! settings. Used when a dial binds the endpoint implicitly, so a second
	//! DuckDB on the same machine can be given its own identity -- otherwise it
	//! loads the same key and iroh refuses with "connecting to ourself".
	QhCore *GetOrCreateCoreFromSettings(DatabaseInstance &db);

private:
	std::mutex core_lock;
	QhCore *core = nullptr;
	//! The relay list the bound endpoint was created with, so a later change to
	//! `quackhole_relays` is refused rather than silently ignored.
	string bound_relays;
};

} // namespace duckdb
