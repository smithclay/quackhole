#define DUCKDB_EXTENSION_MAIN

#include "quackhole_extension.hpp"

#include "duckdb.hpp"
#include "duckdb/common/exception.hpp"
#include "duckdb/common/types/blob.hpp"
#include "duckdb/function/table_function.hpp"
#include "duckdb/main/connection.hpp"
#include "duckdb/main/database.hpp"
#include "duckdb/main/extension_helper.hpp"
#include "duckdb/parser/keyword_helper.hpp"
#include "duckdb/planner/extension_callback.hpp"
#include "quackhole_core.h"
#include "quackhole_http.hpp"
#include "quackhole_state.hpp"

namespace duckdb {

namespace {

constexpr const char *DEFAULT_TARGET = "127.0.0.1:9494";

//! Workbench that quackhole_serve()'s `url` column points at.
//!
//! Baked in so the common case is one statement and one clickable link, and
//! overridable via the quackhole_workbench_url setting for anyone self-hosting
//! web/ rather than using the public deployment.
constexpr const char *DEFAULT_WORKBENCH_URL = "https://smithclay.github.io/quackhole/";
constexpr uint64_t STOP_DEADLINE_MS = 5000;

//! Re-install our HTTP util whenever another extension finishes loading.
//!
//! httpfs unconditionally calls SetHTTPUtil when it loads, so without this a
//! `LOAD httpfs` after `LOAD quackhole` would silently route .iroh hosts into
//! httpfs, where they fail at getaddrinfo. Both duckdb-tailscale and quackscale
//! only document that ordering constraint; re-arming removes it.
class QuackholeExtensionCallback : public ExtensionCallback {
public:
	void OnExtensionLoaded(DatabaseInstance &db, const string &name) override {
		if (name == "quackhole") {
			return;
		}
		RearmQuackholeHTTPUtil(db);
	}
};

string GetVarchar(TableFunctionBindInput &input, const char *name, const string &fallback) {
	auto entry = input.named_parameters.find(name);
	if (entry == input.named_parameters.end() || entry->second.IsNull()) {
		return fallback;
	}
	return entry->second.GetValue<string>();
}

bool GetBool(TableFunctionBindInput &input, const char *name, bool fallback) {
	auto entry = input.named_parameters.find(name);
	if (entry == input.named_parameters.end() || entry->second.IsNull()) {
		return fallback;
	}
	return entry->second.GetValue<bool>();
}

vector<string> GetStringList(TableFunctionBindInput &input, const char *name) {
	vector<string> result;
	auto entry = input.named_parameters.find(name);
	if (entry == input.named_parameters.end() || entry->second.IsNull()) {
		return result;
	}
	for (auto &value : ListValue::GetChildren(entry->second)) {
		if (!value.IsNull()) {
			result.push_back(value.ToString());
		}
	}
	return result;
}

string EndpointId(QhCore *core) {
	char buffer[QH_ENDPOINT_ID_LEN] = {0};
	if (qh_endpoint_id(core, /* z32 */ true, buffer, sizeof(buffer)) != QH_OK) {
		throw InternalException("quackhole: endpoint id did not fit its buffer");
	}
	return string(buffer);
}

string RelayUrl(QhCore *core) {
	char buffer[512] = {0};
	if (qh_relay_url(core, buffer, sizeof(buffer)) != QH_OK) {
		return string();
	}
	return string(buffer);
}

//! How long quackhole_serve() waits for the endpoint to learn its home relay.
//!
//! Long enough to cover the usual case on a cold endpoint, short enough that a
//! genuinely relay-less network does not look like a hang. Falling through
//! leaves ticket and url NULL rather than minting a ticket that omits the relay.
//!
//! Tunable because the wait is only worth paying for when someone is going to
//! use the link: a test that calls quackhole_serve() for its lifecycle side
//! effects sets this to 0 rather than stalling on a relay it never reads.
constexpr uint64_t DEFAULT_RELAY_WAIT_MS = 10000;

string RelayUrlWait(DatabaseInstance &db, QhCore *core) {
	uint64_t wait_ms = DEFAULT_RELAY_WAIT_MS;
	Value setting;
	if (db.TryGetCurrentSetting("quackhole_relay_wait_ms", setting) && !setting.IsNull()) {
		auto configured = setting.GetValue<int64_t>();
		wait_ms = configured < 0 ? 0 : static_cast<uint64_t>(configured);
	}
	char buffer[512] = {0};
	if (qh_relay_url_wait(core, wait_ms, buffer, sizeof(buffer)) != QH_OK) {
		return string();
	}
	return string(buffer);
}

//! base64url, as the ticket carries it: the two non-URL-safe alphabet
//! characters swapped and the padding dropped, so the whole ticket survives a
//! URL fragment untouched. site/ticket.js decodes exactly this.
string Base64Url(const string &input) {
	auto encoded = Blob::ToBase64(string_t(input));
	string result;
	result.reserve(encoded.size());
	for (auto c : encoded) {
		if (c == '+') {
			result += '-';
		} else if (c == '/') {
			result += '_';
		} else if (c != '=') {
			result += c;
		}
	}
	return result;
}

//! `qh1_` + base64url of {"e": endpoint id, "r": relay, "t": token}.
//!
//! This is the only place the ticket is minted. It used to be spelled out in
//! the demo script and again in the page's by-hand SQL, which meant three
//! encoders that had to agree on a format none of them owned.
//!
//! Returns "" when there is no relay to put in it: a ticket without one sends
//! the browser to pkarr and fails on the first click, so no ticket beats a
//! broken one.
string MintTicket(const string &endpoint_id, const string &relay_url, const string &token) {
	if (relay_url.empty()) {
		return string();
	}
	// endpoint ids are z-base-32 and relays are URLs, but the token is whatever
	// the caller passed to token :=, so it is the one field that can carry a
	// quote or a backslash into the JSON.
	string escaped;
	escaped.reserve(token.size());
	for (auto c : token) {
		if (c == '"' || c == '\\') {
			escaped += '\\';
		}
		escaped += c;
	}
	return "qh1_" + Base64Url("{\"e\":\"" + endpoint_id + "\",\"r\":\"" + relay_url + "\",\"t\":\"" + escaped + "\"}");
}

//===--------------------------------------------------------------------===//
// quackhole_serve
//===--------------------------------------------------------------------===//

struct QuackholeServeBindData : public TableFunctionData {
	string token;
	string target = DEFAULT_TARGET;
	vector<string> allow;
	bool ephemeral = false;
	bool auto_serve = true;
	bool finished = false;
};

unique_ptr<FunctionData> QuackholeServeBind(ClientContext &context, TableFunctionBindInput &input,
                                            vector<LogicalType> &return_types, vector<string> &names) {
	auto bind_data = make_uniq<QuackholeServeBindData>();
	bind_data->token = GetVarchar(input, "token", "");
	bind_data->target = GetVarchar(input, "target", DEFAULT_TARGET);
	bind_data->allow = GetStringList(input, "allow");
	bind_data->ephemeral = GetBool(input, "ephemeral", false);
	bind_data->auto_serve = GetBool(input, "auto_serve", true);

	return_types = {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::VARCHAR,
	                LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::VARCHAR};
	// ticket and url are appended rather than inserted: attach_sql is documented
	// by position in more than one place, and moving it would break them quietly.
	names = {"endpoint_id", "relay_url", "token", "attach_sql", "ticket", "url"};
	return std::move(bind_data);
}

//! Start a local Quack server on `target` unless one is already listening.
//!
//! Runs on a fresh Connection rather than the caller's ClientContext: issuing a
//! query on the context that is currently executing a table function invites
//! re-entrancy problems, and Quack's server registry is per-database, so the
//! server outlives this connection.
//!
//! Returns the token Quack is using, or "" if we did not start it.
string MaybeStartQuackServer(DatabaseInstance &db, const string &target, const string &token) {
	ExtensionHelper::TryAutoLoadExtension(db, "quack");

	// Quote the target the same way as the token: it is user-supplied, and
	// splicing it raw lets a crafted `target` close the literal and run arbitrary
	// SQL on the fresh Connection below -- invisibly, since we swallow errors.
	string sql = "CALL quack_serve(" + KeywordHelper::WriteQuoted("quack:" + target, '\'');
	if (!token.empty()) {
		sql += ", token := " + KeywordHelper::WriteQuoted(token, '\'');
	}
	sql += ")";

	Connection con(db);
	auto result = con.Query(sql);
	if (result->HasError()) {
		// The common failure is "address already in use", which is the
		// documented "bridge to whatever is already listening" case. Anything
		// else will surface when the first stream fails to connect.
		return string();
	}
	auto chunk = result->Fetch();
	if (!chunk || chunk->size() == 0 || chunk->ColumnCount() < 3) {
		return string();
	}
	return chunk->GetValue(2, 0).ToString();
}

void QuackholeServeFunction(ClientContext &context, TableFunctionInput &data_p, DataChunk &output) {
	auto &bind_data = data_p.bind_data->CastNoConst<QuackholeServeBindData>();
	if (bind_data.finished) {
		return;
	}
	auto &db = DatabaseInstance::GetDatabase(context);

	auto quack_token = bind_data.auto_serve ? MaybeStartQuackServer(db, bind_data.target, bind_data.token) : string();

	auto &state = QuackholeState::Get(db);
	// An explicit ephemeral := true wins over the setting; otherwise fall back to
	// the same settings a dial would use, so both paths agree on identity.
	// If a core is already bound (a prior ATTACH binds one implicitly), a request
	// for a throwaway identity cannot be honoured -- and silently serving on the
	// long-lived, published key instead is exactly the surprise a user asking for
	// `ephemeral` is trying to avoid. Say so rather than ignoring it.
	if (bind_data.ephemeral && state.TryGetCore()) {
		throw InvalidInputException("quackhole: an endpoint is already bound, so ephemeral := true cannot be "
		                            "honoured. Set 'quackhole_ephemeral' before the first ATTACH or "
		                            "quackhole_serve() on this database.");
	}
	auto *core = bind_data.ephemeral ? state.GetOrCreateCore("", true) : state.GetOrCreateCoreFromSettings(db);

	vector<const char *> allow_ptrs;
	allow_ptrs.reserve(bind_data.allow.size());
	for (auto &entry : bind_data.allow) {
		allow_ptrs.push_back(entry.c_str());
	}

	char err[QH_ERR_LEN] = {0};
	if (qh_serve_start(core, bind_data.target.c_str(), allow_ptrs.empty() ? nullptr : allow_ptrs.data(),
	                   allow_ptrs.size(), err, sizeof(err)) != QH_OK) {
		throw IOException("quackhole_serve failed: %s", err);
	}
	// Mark finished as soon as the side effect lands: if populating the output
	// throws, a re-scan must not try to start the accept loop twice.
	bind_data.finished = true;

	auto endpoint_id = EndpointId(core);
	auto effective_token = bind_data.token.empty() ? quack_token : bind_data.token;
	auto attach_sql = "CREATE SECRET (TYPE quack, TOKEN '" + effective_token + "'); ATTACH 'quack:" + endpoint_id +
	                  ".iroh:9494' AS remote;";

	// Wait, rather than read once: a link is the whole point of this function's
	// output now, and a link minted before the relay is known does not work.
	auto relay = RelayUrlWait(db, core);
	auto ticket = MintTicket(endpoint_id, relay, effective_token);

	string url;
	if (!ticket.empty()) {
		Value setting;
		string base = DEFAULT_WORKBENCH_URL;
		if (db.TryGetCurrentSetting("quackhole_workbench_url", setting) && !setting.IsNull()) {
			base = setting.ToString();
		}
		// The ticket lives in the fragment so it never reaches the server hosting
		// the workbench -- it carries the token, and a query string would land in
		// access logs and Referer headers.
		if (!base.empty()) {
			url = base + (base.back() == '#' ? "" : "#") + ticket;
		}
	}

	output.SetCardinality(1);
	output.SetValue(0, 0, Value(endpoint_id));
	output.SetValue(1, 0, relay.empty() ? Value(LogicalType::VARCHAR) : Value(relay));
	output.SetValue(2, 0, effective_token.empty() ? Value(LogicalType::VARCHAR) : Value(effective_token));
	output.SetValue(3, 0, Value(attach_sql));
	output.SetValue(4, 0, ticket.empty() ? Value(LogicalType::VARCHAR) : Value(ticket));
	output.SetValue(5, 0, url.empty() ? Value(LogicalType::VARCHAR) : Value(url));
}

//===--------------------------------------------------------------------===//
// quackhole_stop
//===--------------------------------------------------------------------===//

struct QuackholeStopBindData : public TableFunctionData {
	bool finished = false;
};

unique_ptr<FunctionData> QuackholeStopBind(ClientContext &context, TableFunctionBindInput &input,
                                           vector<LogicalType> &return_types, vector<string> &names) {
	return_types = {LogicalType::BOOLEAN};
	names = {"stopped"};
	return make_uniq<QuackholeStopBindData>();
}

void QuackholeStopFunction(ClientContext &context, TableFunctionInput &data_p, DataChunk &output) {
	auto &bind_data = data_p.bind_data->CastNoConst<QuackholeStopBindData>();
	if (bind_data.finished) {
		return;
	}
	auto &state = QuackholeState::Get(DatabaseInstance::GetDatabase(context));
	auto *core = state.TryGetCore();
	bool stopped = false;
	if (core) {
		stopped = qh_serve_stop(core, STOP_DEADLINE_MS) == QH_OK;
	}
	bind_data.finished = true;

	output.SetCardinality(1);
	output.SetValue(0, 0, Value::BOOLEAN(stopped));
}

//===--------------------------------------------------------------------===//
// quackhole_status
//===--------------------------------------------------------------------===//

struct QuackholeStatusBindData : public TableFunctionData {
	bool finished = false;
};

unique_ptr<FunctionData> QuackholeStatusBind(ClientContext &context, TableFunctionBindInput &input,
                                             vector<LogicalType> &return_types, vector<string> &names) {
	return_types = {LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::BOOLEAN,
	                LogicalType::VARCHAR, LogicalType::VARCHAR, LogicalType::VARCHAR};
	names = {"endpoint_id", "relay_url", "serving", "peer_id", "peer_path", "peer_direction"};
	return make_uniq<QuackholeStatusBindData>();
}

//! One row per known peer; a single row with NULL peer columns when there are
//! none, so `FROM quackhole_status()` always shows the local endpoint id.
void QuackholeStatusFunction(ClientContext &context, TableFunctionInput &data_p, DataChunk &output) {
	auto &bind_data = data_p.bind_data->CastNoConst<QuackholeStatusBindData>();
	if (bind_data.finished) {
		return;
	}
	bind_data.finished = true;

	auto &state = QuackholeState::Get(DatabaseInstance::GetDatabase(context));
	auto *core = state.TryGetCore();
	if (!core) {
		// Not bound yet: report an empty status rather than binding an endpoint
		// as a side effect of asking for status.
		output.SetCardinality(1);
		output.SetValue(0, 0, Value(LogicalType::VARCHAR));
		output.SetValue(1, 0, Value(LogicalType::VARCHAR));
		output.SetValue(2, 0, Value::BOOLEAN(false));
		output.SetValue(3, 0, Value(LogicalType::VARCHAR));
		output.SetValue(4, 0, Value(LogicalType::VARCHAR));
		output.SetValue(5, 0, Value(LogicalType::VARCHAR));
		return;
	}

	auto endpoint_id = EndpointId(core);
	auto relay = RelayUrl(core);
	auto serving = qh_is_serving(core);
	auto peer_count = qh_peer_count(core);

	idx_t row_count = peer_count == 0 ? 1 : MinValue<idx_t>(peer_count, STANDARD_VECTOR_SIZE);
	output.SetCardinality(row_count);
	for (idx_t row = 0; row < row_count; row++) {
		output.SetValue(0, row, Value(endpoint_id));
		output.SetValue(1, row, relay.empty() ? Value(LogicalType::VARCHAR) : Value(relay));
		output.SetValue(2, row, Value::BOOLEAN(serving));

		char peer_id[QH_ENDPOINT_ID_LEN] = {0};
		char peer_path[32] = {0};
		char peer_dir[32] = {0};
		if (peer_count > 0 && qh_peer_info(core, row, peer_id, sizeof(peer_id), peer_path, sizeof(peer_path), peer_dir,
		                                   sizeof(peer_dir)) == QH_OK) {
			output.SetValue(3, row, Value(string(peer_id)));
			output.SetValue(4, row, Value(string(peer_path)));
			output.SetValue(5, row, Value(string(peer_dir)));
		} else {
			output.SetValue(3, row, Value(LogicalType::VARCHAR));
			output.SetValue(4, row, Value(LogicalType::VARCHAR));
			output.SetValue(5, row, Value(LogicalType::VARCHAR));
		}
	}
}

} // namespace

static void LoadInternal(ExtensionLoader &loader) {
	auto &db = loader.GetDatabaseInstance();

	// Per-DatabaseInstance state. Its destructor stops the tokio runtime and the
	// iroh endpoint on database close.
	QuackholeState::Register(db);

	// Route .iroh hosts over iroh, and keep doing so if httpfs loads later.
	RegisterQuackholeHTTPUtil(db);
	ExtensionCallback::Register(db.config, make_shared_ptr<QuackholeExtensionCallback>());

	// Identity settings. They matter most when a dial binds the endpoint
	// implicitly: two DuckDB processes on one machine would otherwise load the
	// same ~/.quackhole/key, share an endpoint id, and iroh would refuse the
	// connection with "connecting to ourself is not supported".
	db.config.AddExtensionOption("quackhole_key_path",
	                             "Path to the persisted iroh endpoint key (default: ~/.quackhole/key)",
	                             LogicalType::VARCHAR);
	db.config.AddExtensionOption("quackhole_ephemeral", "Use a throwaway endpoint key instead of the persisted one",
	                             LogicalType::BOOLEAN, Value::BOOLEAN(false));
	// Address lookup is a round trip to a third party that must also have seen
	// the peer publish, and a server that started seconds ago routinely has not.
	// The relay URL is printed by quackhole_status() next to the endpoint id, so
	// whoever hands out the id can hand out this too.
	db.config.AddExtensionOption("quackhole_relay_url",
	                             "Relay to reach peers through, skipping address lookup (default: look up)",
	                             LogicalType::VARCHAR);
	// Only affects the `url` column quackhole_serve() returns. Set it when you
	// host web/ yourself; the ticket in the fragment is the same either way.
	db.config.AddExtensionOption("quackhole_relay_wait_ms",
	                             "How long quackhole_serve() waits for a home relay before returning a NULL ticket",
	                             LogicalType::BIGINT, Value::BIGINT(DEFAULT_RELAY_WAIT_MS));
	db.config.AddExtensionOption(
	    "quackhole_workbench_url",
	    "Workbench URL that quackhole_serve()'s url column points at (default: " + string(DEFAULT_WORKBENCH_URL) + ")",
	    LogicalType::VARCHAR);

	TableFunction serve("quackhole_serve", {}, QuackholeServeFunction, QuackholeServeBind);
	serve.named_parameters["token"] = LogicalType::VARCHAR;
	serve.named_parameters["target"] = LogicalType::VARCHAR;
	serve.named_parameters["allow"] = LogicalType::LIST(LogicalType::VARCHAR);
	serve.named_parameters["ephemeral"] = LogicalType::BOOLEAN;
	serve.named_parameters["auto_serve"] = LogicalType::BOOLEAN;
	loader.RegisterFunction(serve);

	TableFunction stop("quackhole_stop", {}, QuackholeStopFunction, QuackholeStopBind);
	loader.RegisterFunction(stop);

	TableFunction status("quackhole_status", {}, QuackholeStatusFunction, QuackholeStatusBind);
	loader.RegisterFunction(status);
}

void QuackholeExtension::Load(ExtensionLoader &loader) {
	LoadInternal(loader);
}

std::string QuackholeExtension::Name() {
	return "quackhole";
}

std::string QuackholeExtension::Version() const {
#ifdef EXT_VERSION_QUACKHOLE
	return EXT_VERSION_QUACKHOLE;
#else
	return "";
#endif
}

} // namespace duckdb

extern "C" {

DUCKDB_CPP_EXTENSION_ENTRY(quackhole, loader) {
	duckdb::LoadInternal(loader);
}
}
