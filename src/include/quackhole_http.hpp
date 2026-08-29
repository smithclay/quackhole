#pragma once

#include "duckdb/common/http_util.hpp"

struct QhCore;

namespace duckdb {

class DatabaseInstance;

//! True if `proto_host_port` (e.g. "https://<id>.iroh:9494") names an iroh
//! endpoint: the hostname's last label is "iroh". Scheme, path and :port are
//! stripped before the test.
//!
//! Unlike the tailnet equivalent in quackscale, https:// is intercepted too.
//! A .iroh host is reachable over no other transport, and QUIC is already the
//! encryption layer, so there is nothing to hand to a real TLS stack.
bool IsIrohHost(const string &proto_host_port);

//! The endpoint id from a .iroh host -- everything before the final ".iroh".
//! Empty if `proto_host_port` is not an iroh host.
string ExtractEndpointId(const string &proto_host_port);

//! Install QuackholeHTTPUtil as the database's HTTP util, wrapping whatever is
//! currently registered. Idempotent. Called on LOAD and re-armed by
//! QuackholeExtensionCallback whenever another extension loads, because httpfs
//! unconditionally reclaims the slot when it loads.
void RegisterQuackholeHTTPUtil(DatabaseInstance &db);

//! Re-wrap the HTTP util if something displaced us, without auto-loading httpfs.
//!
//! Called from an ExtensionCallback on every extension load, so it must not
//! itself trigger a load -- that would recurse.
void RearmQuackholeHTTPUtil(DatabaseInstance &db);

//! HTTP/1.1 over an iroh bi-stream.
//!
//! The Rust core has no HTTP awareness: it writes the request bytes we build and
//! returns every byte the peer sent back. All framing is decided here, so there
//! is one HTTP implementation shared by every transport.
class QuackholeHTTPClient : public HTTPClient {
public:
	QuackholeHTTPClient(const string &proto_host_port, QhCore *core);

	void Initialize(HTTPParams &http_params) override;
	//! Optional relay to reach the peer through, skipping address lookup.
	void SetRelayUrl(string url) {
		relay_url = std::move(url);
	}

	unique_ptr<HTTPResponse> Get(GetRequestInfo &info) override;
	unique_ptr<HTTPResponse> Post(PostRequestInfo &info) override;
	unique_ptr<HTTPResponse> Put(PutRequestInfo &info) override;
	unique_ptr<HTTPResponse> Head(HeadRequestInfo &info) override;
	unique_ptr<HTTPResponse> Delete(DeleteRequestInfo &info) override;

private:
	//! Build the request, send it on a bi-stream, and parse the reply.
	unique_ptr<HTTPResponse> RoundTrip(const string &method, const string &path, const HTTPHeaders &headers,
	                                   const_data_ptr_t body, idx_t body_len, bool has_body,
	                                   const string &content_type = string());

	string endpoint_id; //!< iroh endpoint id parsed out of the hostname
	string host;        //!< full hostname including the .iroh label, for the Host header
	//! Optional relay hint from the quackhole_relay_url setting. Empty means
	//! resolve the peer by address lookup, which is the default.
	string relay_url;
	string port;
	QhCore *core;
	uint32_t timeout_ms = 30000;
};

//! Routes .iroh hosts over iroh and delegates everything else to the previously
//! registered util (httpfs), preserving its TLS, proxies, secrets and
//! keep-alive cache for ordinary traffic.
class QuackholeHTTPUtil : public HTTPUtil {
public:
	QuackholeHTTPUtil(HTTPUtil &prev, DatabaseInstance &db) : prev(prev), db(db) {
	}

	string GetName() const override {
		return "Quackhole";
	}

	unique_ptr<HTTPParams> InitializeParameters(DatabaseInstance &db_p, const string &path) override {
		return prev.InitializeParameters(db_p, path);
	}
	unique_ptr<HTTPParams> InitializeParameters(ClientContext &context, const string &path) override {
		return prev.InitializeParameters(context, path);
	}
	unique_ptr<HTTPParams> InitializeParameters(optional_ptr<FileOpener> opener,
	                                            optional_ptr<FileOpenerInfo> info) override {
		return prev.InitializeParameters(opener, info);
	}

	unique_ptr<HTTPClient> InitializeClient(HTTPParams &http_params, const string &proto_host_port) override;
	void CloseClient(unique_ptr<HTTPClient> &&client) override;

private:
	//! The previously registered util. DBConfig::SetHTTPUtil keeps displaced
	//! utils alive in old_http_utils for the database's lifetime, so this
	//! reference stays valid (see duckdb/src/main/config.cpp).
	HTTPUtil &prev;
	//! Owns the QuackholeState the clients dial through. DBConfig outlives us.
	DatabaseInstance &db;
};

} // namespace duckdb
