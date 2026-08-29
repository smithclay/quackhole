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

//! Reject CR/LF in anything spliced into the request head.
//!
//! Without this, a path or header value carrying \r\n terminates the header
//! block early and injects a second request into the peer's Quack server -- and
//! lets a caller reinstate the Connection/Content-Length headers this file
//! deliberately strips, breaking the framing the whole design rests on.
//! InvalidInputException (not IOException/HTTPException) so RunRequestWithRetry
//! propagates it immediately instead of retrying a deterministic failure.
void RejectHeaderInjection(const string &what, const string &value) {
	if (value.find('\r') != string::npos || value.find('\n') != string::npos) {
		throw InvalidInputException("quackhole: %s must not contain CR or LF", what);
	}
}

//! Request line + headers. Any caller-supplied Host/Content-Length/Connection/
//! Transfer-Encoding is dropped so we own framing end to end.
string BuildRequestHead(const string &method, const string &path, const string &host, const string &port,
                        const HTTPHeaders &headers, idx_t content_length, bool has_body,
                        const string &content_type) {
	RejectHeaderInjection("request path", path);
	RejectHeaderInjection("host", host);
	RejectHeaderInjection("port", port);

	string request = method + " " + (path.empty() ? "/" : path) + " HTTP/1.1\r\n";
	request += "Host: " + host + ":" + port + "\r\n";
	bool has_content_type = false;
	for (auto &header : headers) {
		RejectHeaderInjection("header name", header.first);
		RejectHeaderInjection("header value", header.second);
		auto key = StringUtil::Lower(header.first);
		if (key == "host" || key == "content-length" || key == "connection" || key == "transfer-encoding") {
			continue;
		}
		if (key == "content-type") {
			has_content_type = true;
		}
		request += header.first + ": " + header.second + "\r\n";
	}
	if (has_body) {
		request += "Content-Length: " + std::to_string(content_length) + "\r\n";
		if (!has_content_type) {
			// Quack sets no headers of its own; httpfs normally adds this, and
			// we have replaced httpfs on this path. An explicit content_type from
			// the caller (PutRequestInfo carries one) wins over the default.
			auto effective = content_type.empty() ? string("application/octet-stream") : content_type;
			RejectHeaderInjection("content type", effective);
			request += "Content-Type: " + effective + "\r\n";
		}
	}
	// One request per bi-stream. Asking the peer to close means the loopback TCP
	// FIN propagates to a QUIC stream FIN, which is our end-of-response signal
	// when no Content-Length is sent.
	request += "Connection: close\r\n\r\n";
	return request;
}

//! Index of `needle` within [data, data+len), or DConstants::INVALID_INDEX.
//!
//! memchr-then-memcmp rather than a naive double loop: the miss case scans the
//! whole response, which can be hundreds of megabytes.
idx_t FindBytes(const char *data, idx_t len, const char *needle, idx_t needle_len) {
	if (needle_len == 0 || len < needle_len) {
		return DConstants::INVALID_INDEX;
	}
	const char *pos = data;
	idx_t remaining = len;
	while (remaining >= needle_len) {
		auto *hit = static_cast<const char *>(memchr(pos, needle[0], remaining - needle_len + 1));
		if (!hit) {
			return DConstants::INVALID_INDEX;
		}
		if (memcmp(hit, needle, needle_len) == 0) {
			return static_cast<idx_t>(hit - data);
		}
		auto consumed = static_cast<idx_t>(hit - pos) + 1;
		remaining -= consumed;
		pos = hit + 1;
	}
	return DConstants::INVALID_INDEX;
}

//! Owns a QhResponse for the duration of a round trip.
//!
//! The response bytes stay in the Rust allocation and are parsed in place, so
//! the body is copied exactly once -- into the string DuckDB keeps. Freeing has
//! to outlive that parse, which is what this guard is for.
struct QhResponseHandle {
	QhResponse *ptr;

	explicit QhResponseHandle(QhResponse *ptr_p) : ptr(ptr_p) {
	}
	~QhResponseHandle() {
		qh_response_free(ptr);
	}
	QhResponseHandle(const QhResponseHandle &) = delete;
	QhResponseHandle &operator=(const QhResponseHandle &) = delete;

	const char *data() const {
		return const_char_ptr_cast(qh_response_data(ptr));
	}
	idx_t size() const {
		return qh_response_len(ptr);
	}
};

bool ParseDecimal(const string &text, idx_t &out) {
	if (text.empty()) {
		return false;
	}
	for (char c : text) {
		if (c < '0' || c > '9') {
			return false;
		}
	}
	try {
		out = static_cast<idx_t>(std::stoull(text));
	} catch (...) {
		return false;
	}
	return true;
}

bool ParseHex(const string &text, idx_t &out) {
	if (text.empty()) {
		return false;
	}
	for (char c : text) {
		bool is_hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
		if (!is_hex) {
			return false;
		}
	}
	try {
		out = static_cast<idx_t>(std::stoull(text, nullptr, 16));
	} catch (...) {
		return false;
	}
	return true;
}

//! Parse the status line and header block.
void ParseHead(const string &head, int32_t &status_out, string &reason_out, HTTPHeaders &headers_out) {
	auto lines = StringUtil::Split(head, "\r\n");
	if (lines.empty()) {
		status_out = 0;
		return;
	}
	auto &status_line = lines[0];
	auto first_space = status_line.find(' ');
	if (first_space != string::npos) {
		auto second_space = status_line.find(' ', first_space + 1);
		auto code = status_line.substr(first_space + 1, second_space == string::npos
		                                                   ? string::npos
		                                                   : second_space - first_space - 1);
		status_out = std::atoi(code.c_str());
		if (second_space != string::npos) {
			reason_out = status_line.substr(second_space + 1);
		}
	}
	for (idx_t i = 1; i < lines.size(); i++) {
		auto colon = lines[i].find(':');
		if (colon == string::npos) {
			continue;
		}
		auto key = lines[i].substr(0, colon);
		auto value = lines[i].substr(colon + 1);
		StringUtil::Trim(key);
		StringUtil::Trim(value);
		headers_out.Insert(key, value);
	}
}

string HeaderValueLower(const HTTPHeaders &headers, const string &key) {
	if (!headers.HasHeader(key)) {
		return string();
	}
	return StringUtil::Lower(headers.GetHeaderValue(key));
}

//! Decode a chunked body from a borrowed range. Returns false on malformed input.
bool DecodeChunked(const char *data, idx_t len, string &out) {
	idx_t pos = 0;
	while (pos < len) {
		auto line_end = FindBytes(data + pos, len - pos, "\r\n", 2);
		if (line_end == DConstants::INVALID_INDEX) {
			return false;
		}
		string size_line(data + pos, line_end);
		// Strip any chunk extension (";name=value").
		auto semicolon = size_line.find(';');
		if (semicolon != string::npos) {
			size_line = size_line.substr(0, semicolon);
		}
		StringUtil::Trim(size_line);
		idx_t chunk_size = 0;
		if (!ParseHex(size_line, chunk_size)) {
			return false;
		}
		pos += line_end + 2;
		if (chunk_size == 0) {
			return true; // trailers, if any, are ignored
		}
		// Written as a subtraction: `pos + chunk_size` overflows idx_t for a
		// chunk-size line like "ffffffffffffffee", which would slip past the
		// guard and then wind `pos` backwards into an infinite re-scan.
		if (chunk_size > len - pos) {
			return false;
		}
		out.append(data + pos, chunk_size);
		pos += chunk_size;
		// Skip the CRLF that terminates the chunk.
		if (pos + 2 <= len) {
			pos += 2;
		}
	}
	return false; // ran out of input before the terminating zero-length chunk
}

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
unique_ptr<HTTPResponse> BuildResponse(int32_t status, string reason, HTTPHeaders headers, string body) {
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

	auto request = BuildRequestHead(method, path, host, port, headers, body_len, has_body, content_type);
	if (has_body && body_len > 0) {
		request.append(const_char_ptr_cast(body), body_len);
	}

	char err[QH_ERR_LEN] = {0};
	QhResponseHandle raw(qh_request(core, endpoint_id.c_str(), const_data_ptr_cast(request.data()), request.size(),
	                                timeout_ms, err, sizeof(err)));
	if (!raw.ptr) {
		// Surface as a transport error rather than throwing, so DuckDB's retry
		// logic in RunRequestWithRetry can see it like any other failure.
		return TransportError(StringUtil::Format("quackhole: %s", err));
	}

	// Everything below reads straight out of the Rust allocation. Copying it into
	// a std::string first, then substr-ing off the head, then substr-ing the body
	// again, meant a large fetch peaked at several times its transferred size.
	const char *data = raw.data();
	const idx_t len = raw.size();

	auto header_end = FindBytes(data, len, "\r\n\r\n", 4);
	if (header_end == DConstants::INVALID_INDEX) {
		return TransportError("quackhole: peer sent a truncated HTTP response");
	}

	int32_t status = 0;
	string reason;
	HTTPHeaders response_headers;
	// The head is small; the body is what we care about not duplicating.
	ParseHead(string(data, header_end), status, reason, response_headers);

	const char *body_data = data + header_end + 4;
	const idx_t body_len_in = len - header_end - 4;

	string body_out;
	if (method == "HEAD") {
		// A HEAD response carries Content-Length but no body.
	} else if (HeaderValueLower(response_headers, "transfer-encoding") == "chunked") {
		if (!DecodeChunked(body_data, body_len_in, body_out)) {
			return TransportError("quackhole: malformed chunked response body");
		}
	} else if (response_headers.HasHeader("Content-Length")) {
		idx_t content_length = 0;
		if (ParseDecimal(response_headers.GetHeaderValue("Content-Length"), content_length)) {
			if (content_length > body_len_in) {
				// The stream ended early -- the serving side's bridge died, or the
				// peer was killed mid-response. Silently clamping here would hand
				// DuckDB a truncated Parquet/Quack payload as a successful read.
				return TransportError(StringUtil::Format(
				    "quackhole: peer promised %llu body bytes but sent %llu", content_length, body_len_in));
			}
			body_out.assign(body_data, content_length);
		} else {
			body_out.assign(body_data, body_len_in);
		}
	} else {
		// No framing headers: the stream FIN was the end of the body. This is
		// the normal path, because we send Connection: close.
		body_out.assign(body_data, body_len_in);
	}

	if (status == 0) {
		return TransportError("quackhole: peer sent an unparseable HTTP status line");
	}
	return BuildResponse(status, std::move(reason), std::move(response_headers), std::move(body_out));
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
