#include "quackhole_http.hpp"

#include "duckdb/common/exception.hpp"
#include "duckdb/common/string_util.hpp"
#include "duckdb/main/database.hpp"
#include "duckdb/main/extension_helper.hpp"
#include "quackhole_core.h"
#include "quackhole_state.hpp"

namespace duckdb {

namespace {

//! Split "https://host:port/path" into host and port. IPv6 literals are not
//! handled: an iroh endpoint id is never one.
void ParseProtoHostPort(const string &proto_host_port, string &host_out, string &port_out) {
	string value = proto_host_port;
	auto scheme = value.find("://");
	if (scheme != string::npos) {
		value = value.substr(scheme + 3);
	}
	auto slash = value.find('/');
	if (slash != string::npos) {
		value = value.substr(0, slash);
	}
	auto colon = value.rfind(':');
	if (colon != string::npos) {
		port_out = value.substr(colon + 1);
		host_out = value.substr(0, colon);
	} else {
		host_out = value;
		port_out = "9494";
	}
}

constexpr const char *IROH_SUFFIX = ".iroh";

//! Owns a QhResponse for the duration of a round trip.
//!
//! The core parses; this borrows the result only long enough to marshal it into
//! DuckDB's types, so the body is copied exactly once -- into the string DuckDB
//! keeps. Freeing has to outlive that copy, which is what this guard is for.
struct QhResponseHandle {
	QhResponse *ptr;

	explicit QhResponseHandle(QhResponse *ptr_p) : ptr(ptr_p) {
	}
	~QhResponseHandle() {
		qh_response_free(ptr);
	}
	QhResponseHandle(const QhResponseHandle &) = delete;
	QhResponseHandle &operator=(const QhResponseHandle &) = delete;
};

//! A genuine transport failure: no usable HTTP response came back.
//!
//! `request_error` means "retry me" to DuckDB, so it belongs only here.
unique_ptr<HTTPResponse> TransportError(const string &message) {
	auto response = make_uniq<HTTPResponse>(HTTPStatusCode::INVALID);
	response->success = false;
	response->request_error = message;
	return response;
}

//! A real HTTP response, whatever its status.
unique_ptr<HTTPResponse> BuildResponse(uint16_t status, string reason, HTTPHeaders headers, string body) {
	auto response = make_uniq<HTTPResponse>(HTTPUtil::ToStatusCode(status));
	response->body = std::move(body);
	response->reason = std::move(reason);
	response->headers = std::move(headers);
	// Deliberately NOT setting request_error. HTTPResponse::ShouldRetry() returns
	// true unconditionally when request_error is non-empty, so stamping one on a
	// 401 or 404 makes DuckDB re-send the request `http_retries` times and then
	// throw a generic HTTPException instead of returning the status -- which also
	// breaks httpfs paths that probe for existence via a 404.
	// HTTPResponse::success defaults to true, so an unparseable status line still
	// has to be corrected here; RunRequestWithRetry recomputes it from the status.
	response->success = status >= 200 && status < 300;
	return response;
}

} // namespace

bool IsIrohHost(const string &proto_host_port) {
	string host, port;
	ParseProtoHostPort(proto_host_port, host, port);
	if (host.empty()) {
		return false;
	}
	return StringUtil::EndsWith(StringUtil::Lower(host), IROH_SUFFIX);
}

string ExtractEndpointId(const string &proto_host_port) {
	string host, port;
	ParseProtoHostPort(proto_host_port, host, port);
	if (!StringUtil::EndsWith(StringUtil::Lower(host), IROH_SUFFIX)) {
		return string();
	}
	return host.substr(0, host.size() - strlen(IROH_SUFFIX));
}

//===--------------------------------------------------------------------===//
// QuackholeHTTPClient
//===--------------------------------------------------------------------===//

QuackholeHTTPClient::QuackholeHTTPClient(const string &proto_host_port, QhCore *core)
    : HTTPClient(proto_host_port), core(core) {
	string parsed_port;
	ParseProtoHostPort(proto_host_port, host, parsed_port);
	port = parsed_port;
	endpoint_id = ExtractEndpointId(proto_host_port);
}

//! Read the optional relay hint. Absent means resolve by address lookup.
string RelayUrlSetting(DatabaseInstance &db) {
	Value setting;
	if (db.TryGetCurrentSetting("quackhole_relay_url", setting) && !setting.IsNull()) {
		return setting.ToString();
	}
	return string();
}

void QuackholeHTTPClient::Initialize(HTTPParams &http_params) {
	// DuckDB splits a timeout into whole seconds plus a microsecond remainder;
	// reading only `timeout` turns a configured 500ms into the 30s default.
	auto total_ms = http_params.timeout * 1000 + http_params.timeout_usec / 1000;
	if (total_ms > 0) {
		timeout_ms = static_cast<uint32_t>(MinValue<uint64_t>(total_ms, NumericLimits<uint32_t>::Maximum()));
	}
}

unique_ptr<HTTPResponse> QuackholeHTTPClient::RoundTrip(const string &method, const string &path,
                                                        const HTTPHeaders &headers, const_data_ptr_t body,
                                                        idx_t body_len, bool has_body, const string &content_type) {
	if (endpoint_id.empty()) {
		throw IOException("quackhole: '%s' is not a <endpoint-id>.iroh address", host);
	}

	// Headers flattened into parallel arrays, because that is what a C ABI can
	// carry. Building the head, dropping the framing headers, rejecting CR/LF and
	// parsing the reply all happen in the core -- see quackhole_core.h. This
	// function only marshals.
	vector<const char *> names;
	vector<const char *> values;
	for (auto &header : headers) {
		names.push_back(header.first.c_str());
		values.push_back(header.second.c_str());
	}

	char err[QH_ERR_LEN] = {0};
	QhResponseHandle raw(qh_request(core, endpoint_id.c_str(), relay_url.c_str(), method.c_str(), path.c_str(),
	                                host.c_str(), port.c_str(), names.empty() ? nullptr : names.data(),
	                                values.empty() ? nullptr : values.data(), names.size(), body, body_len, has_body,
	                                content_type.c_str(), timeout_ms, err, sizeof(err)));
	if (!raw.ptr) {
		// Surface as a transport error rather than throwing, so DuckDB's retry
		// logic in RunRequestWithRetry sees it like any other failure. A response
		// the core could not frame lands here too: it reports "peer promised N
		// body bytes but sent M" rather than handing back a truncated payload.
		return TransportError(StringUtil::Format("quackhole: %s", err));
	}

	auto status = qh_response_status(raw.ptr);
	if (status == 0) {
		return TransportError("quackhole: peer sent an unparseable HTTP status line");
	}

	HTTPHeaders response_headers;
	auto header_count = qh_response_header_count(raw.ptr);
	for (idx_t i = 0; i < header_count; i++) {
		auto *name = qh_response_header_name(raw.ptr, i);
		auto *value = qh_response_header_value(raw.ptr, i);
		if (name && value) {
			response_headers.Insert(name, value);
		}
	}

	auto *reason = qh_response_reason(raw.ptr);
	string body_out(const_char_ptr_cast(qh_response_body(raw.ptr)), qh_response_body_len(raw.ptr));
	return BuildResponse(status, reason ? string(reason) : string(), std::move(response_headers), std::move(body_out));
}

unique_ptr<HTTPResponse> QuackholeHTTPClient::Post(PostRequestInfo &info) {
	auto headers = BaseRequest::MergeHeaders(info.headers, info.params);
	auto response = RoundTrip("POST", info.path, headers, info.buffer_in, info.buffer_in_len, true);
	// Quack reads the reply from buffer_out, not from body, so move rather than
	// copy: for a large FETCH this is the difference between one buffer and two.
	// Safe because nothing downstream reads a POST response's body -- DuckDB's
	// HTTP logger records only status, reason and headers
	// (duckdb/src/logging/log_types.cpp:101-107).
	info.buffer_out = std::move(response->body);
	return response;
}

unique_ptr<HTTPResponse> QuackholeHTTPClient::Get(GetRequestInfo &info) {
	auto headers = BaseRequest::MergeHeaders(info.headers, info.params);
	auto response = RoundTrip("GET", info.path, headers, nullptr, 0, false);
	// Honour the streaming callbacks for any caller that does route through this
	// util. Note httpfs is NOT such a caller: it constructs HTTPParams bound to
	// its own util, so read_csv/read_parquet bypass us entirely (see README).
	bool keep_going = true;
	if (info.response_handler) {
		keep_going = info.response_handler(*response);
	}
	if (keep_going && info.content_handler && !response->body.empty()) {
		info.content_handler(const_data_ptr_cast(response->body.data()), response->body.size());
	}
	return response;
}

unique_ptr<HTTPResponse> QuackholeHTTPClient::Put(PutRequestInfo &info) {
	auto headers = BaseRequest::MergeHeaders(info.headers, info.params);
	return RoundTrip("PUT", info.path, headers, info.buffer_in, info.buffer_in_len, true, info.content_type);
}

unique_ptr<HTTPResponse> QuackholeHTTPClient::Head(HeadRequestInfo &info) {
	auto headers = BaseRequest::MergeHeaders(info.headers, info.params);
	return RoundTrip("HEAD", info.path, headers, nullptr, 0, false);
}

unique_ptr<HTTPResponse> QuackholeHTTPClient::Delete(DeleteRequestInfo &info) {
	auto headers = BaseRequest::MergeHeaders(info.headers, info.params);
	return RoundTrip("DELETE", info.path, headers, nullptr, 0, false);
}

//===--------------------------------------------------------------------===//
// QuackholeHTTPUtil
//===--------------------------------------------------------------------===//

unique_ptr<HTTPClient> QuackholeHTTPUtil::InitializeClient(HTTPParams &http_params, const string &proto_host_port) {
	if (!IsIrohHost(proto_host_port)) {
		return prev.InitializeClient(http_params, proto_host_port);
	}
	// Bind the endpoint on first use, so ATTACH works without a prior
	// quackhole_serve(). Throws here -- and therefore in the user's query -- if
	// the endpoint cannot bind.
	auto &state = QuackholeState::Get(db);
	auto *core = state.GetOrCreateCoreFromSettings(db);

	auto client = make_uniq<QuackholeHTTPClient>(proto_host_port, core);
	client->SetRelayUrl(RelayUrlSetting(db));
	client->Initialize(http_params);
	return std::move(client);
}

void QuackholeHTTPUtil::CloseClient(unique_ptr<HTTPClient> &&client) {
	if (!client || !IsIrohHost(client->GetBaseUrl())) {
		// Let httpfs keep caching its keep-alive clients.
		prev.CloseClient(std::move(client));
		return;
	}
	// Ours are cheap and stateless: the QUIC connection they used is cached in
	// the Rust core, keyed by endpoint id, and outlives this object. Dropping
	// the client closes nothing.
}

void RearmQuackholeHTTPUtil(DatabaseInstance &db) {
	auto &current = db.config.GetHTTPUtil();
	if (current.GetName() == "Quackhole") {
		return; // still ours
	}
	// Wrap whatever displaced us. The util we are replacing stays alive in
	// DBConfig::old_http_utils, so chaining like this never dangles.
	db.config.SetHTTPUtil(make_shared_ptr<QuackholeHTTPUtil>(current, db));
}

void RegisterQuackholeHTTPUtil(DatabaseInstance &db) {
	// Make sure httpfs is in place first, so non-.iroh traffic has a real
	// implementation (TLS, proxies, secrets) to delegate to. Best effort: if it
	// is unavailable we wrap whatever is registered.
	ExtensionHelper::TryAutoLoadExtension(db, "httpfs");
	RearmQuackholeHTTPUtil(db);
}

} // namespace duckdb
