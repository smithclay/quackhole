#include "quackhole_state.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/common/file_system.hpp"

#include "quackhole_core.h"

namespace duckdb {

//! Budget for stopping the accept loop and the tokio runtime on close.
static constexpr uint64_t SHUTDOWN_DEADLINE_MS = 5000;

QuackholeStorageExtension::QuackholeStorageExtension() {
	// StorageExtension's function pointers are plain uninitialised members.
	// We never attach, so null them explicitly rather than leaving garbage that
	// DuckDB might call if someone writes ATTACH ... (TYPE quackhole).
	attach = nullptr;
	create_transaction_manager = nullptr;
}

QuackholeState::~QuackholeState() {
	if (core) {
		// Stops the accept loop, closes cached connections, and joins the tokio
		// runtime -- all bounded by the deadline so a wedged peer cannot hang
		// database close.
		qh_core_free(core, SHUTDOWN_DEADLINE_MS);
		core = nullptr;
	}
}

void QuackholeState::Register(DatabaseInstance &db) {
	if (StorageExtension::Find(db.config, STORAGE_EXTENSION_KEY)) {
		return;
	}
	auto extension = make_shared_ptr<QuackholeStorageExtension>();
	extension->storage_info = make_shared_ptr<QuackholeState>();
	StorageExtension::Register(db.config, STORAGE_EXTENSION_KEY, std::move(extension));
}

QuackholeState &QuackholeState::Get(DatabaseInstance &db) {
	auto extension = StorageExtension::Find(db.config, STORAGE_EXTENSION_KEY);
	if (!extension || !extension->storage_info) {
		throw InternalException("quackhole state is missing; was the extension loaded?");
	}
	return *static_cast<QuackholeState *>(extension->storage_info.get());
}

QhCore *QuackholeState::GetOrCreateCore(const string &key_path, bool ephemeral, const string &relays) {
	std::lock_guard<std::mutex> guard(core_lock);
	if (core) {
		return core;
	}
	char err[QH_ERR_LEN] = {0};
	// Binding is synchronous so a bad key path, an unparsable relay or a blocked
	// UDP socket becomes a SQL error here, rather than a silent failure in a
	// background thread.
	core = qh_core_new(ephemeral ? nullptr : key_path.c_str(), ephemeral, relays.c_str(), err, sizeof(err));
	if (!core) {
		throw IOException("Failed to start quackhole endpoint: %s", err);
	}
	// Normalised, so that comparing it later answers "is this a different relay
	// map" rather than "is this a different string". qh_core_new has just parsed
	// the same list, so this cannot fail.
	bound_relays = NormalizeRelays(relays);
	return core;
}

string QuackholeState::NormalizeRelays(const string &relays) {
	// One relay URL is QH_RELAY_URL_LEN; four is what n0 itself publishes, and
	// nobody hand-lists more than that.
	char out[QH_RELAY_URL_LEN * 4] = {0};
	char err[QH_ERR_LEN] = {0};
	if (qh_relays_normalize(relays.c_str(), out, sizeof(out), err, sizeof(err)) != QH_OK) {
		throw InvalidInputException("quackhole: %s", err);
	}
	return string(out);
}

string QuackholeState::BoundRelays() {
	std::lock_guard<std::mutex> guard(core_lock);
	return bound_relays;
}

QhCore *QuackholeState::TryGetCore() {
	std::lock_guard<std::mutex> guard(core_lock);
	return core;
}

QhCore *QuackholeState::GetOrCreateCoreFromSettings(DatabaseInstance &db) {
	Value setting;
	bool ephemeral = false;
	if (db.TryGetCurrentSetting("quackhole_ephemeral", setting) && !setting.IsNull()) {
		ephemeral = BooleanValue::Get(setting);
	}
	string key_path;
	if (db.TryGetCurrentSetting("quackhole_key_path", setting) && !setting.IsNull()) {
		key_path = setting.ToString();
	}
	if (key_path.empty()) {
		key_path = DefaultKeyPath(db);
	}
	return GetOrCreateCore(key_path, ephemeral, RelaysFromSettings(db));
}

string QuackholeState::RelaysFromSettings(DatabaseInstance &db) {
	Value setting;
	if (db.TryGetCurrentSetting("quackhole_relays", setting) && !setting.IsNull()) {
		return setting.ToString();
	}
	return string();
}

string QuackholeState::DefaultKeyPath(DatabaseInstance &db) {
	auto &fs = db.GetFileSystem();
	auto home = fs.GetHomeDirectory();
	if (home.empty()) {
		throw IOException("Could not determine a home directory for the quackhole endpoint key; "
		                  "pass ephemeral := true or set a key path explicitly");
	}
	return fs.JoinPath(fs.JoinPath(home, ".quackhole"), "key");
}

} // namespace duckdb
