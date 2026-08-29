//! HTTP framing for Quack-over-iroh.
//!
//! This lives in the core because both clients need it and neither can share
//! the other's: the native extension drives it from C++, the browser from
//! JavaScript. Two implementations would have to agree about things that are
//! not obvious -- the `Connection: close` framing below, chunk extensions,
//! which caller headers get stripped -- and would drift the moment one side
//! was edited alone.
//!
//! Deliberately not a general HTTP client. It speaks exactly the subset Quack
//! uses, over a transport that gives us one request per stream.

use anyhow::{bail, Result};

/// A request to build. Headers are the caller's; framing headers are ours.
#[derive(Debug)]
pub struct Request<'a> {
    pub method: &'a str,
    pub path: &'a str,
    pub host: &'a str,
    pub port: &'a str,
    pub headers: Vec<(String, String)>,
    pub body: Option<&'a [u8]>,
    /// Used only when the caller supplied no Content-Type and there is a body.
    pub content_type: &'a str,
}

/// A parsed response. `status` is 0 only if the status line was unreadable.
#[derive(Debug, Default)]
pub struct Response {
    pub status: u16,
    pub reason: String,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}

/// Reject CR/LF in anything spliced into the request head.
///
/// Without this a path or header value carrying \r\n terminates the header
/// block early and injects a second request into the peer's Quack server -- and
/// lets a caller reinstate the Connection/Content-Length headers we deliberately
/// strip, breaking the framing the whole design rests on.
fn reject_injection(what: &str, value: &str) -> Result<()> {
    if value.contains('\r') || value.contains('\n') {
        bail!("quackhole: {what} must not contain CR or LF");
    }
    Ok(())
}

/// Headers we own. A caller-supplied copy is dropped rather than merged,
/// because framing is ours end to end.
fn is_framing_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "host" | "content-length" | "connection" | "transfer-encoding"
    )
}

/// Serialise a request: head, then body.
pub fn build_request(req: &Request) -> Result<Vec<u8>> {
    reject_injection("request path", req.path)?;
    reject_injection("host", req.host)?;
    reject_injection("port", req.port)?;

    let path = if req.path.is_empty() { "/" } else { req.path };
    let mut head = format!("{} {} HTTP/1.1\r\n", req.method, path);
    head.push_str(&format!("Host: {}:{}\r\n", req.host, req.port));

    let mut has_content_type = false;
    for (name, value) in &req.headers {
        reject_injection("header name", name)?;
        reject_injection("header value", value)?;
        if is_framing_header(name) {
            continue;
        }
        if name.eq_ignore_ascii_case("content-type") {
            has_content_type = true;
        }
        head.push_str(&format!("{name}: {value}\r\n"));
    }

    let body = req.body.unwrap_or(&[]);
    if req.body.is_some() {
        head.push_str(&format!("Content-Length: {}\r\n", body.len()));
        if !has_content_type {
            // Quack sets no headers of its own; httpfs normally adds this, and
            // we have replaced httpfs on this path.
            let effective = if req.content_type.is_empty() {
                "application/octet-stream"
            } else {
                req.content_type
            };
            reject_injection("content type", effective)?;
            head.push_str(&format!("Content-Type: {effective}\r\n"));
        }
    }

    // One request per bi-stream. Asking the peer to close is what makes the
    // loopback TCP FIN propagate to a QUIC stream FIN, which is our
    // end-of-response signal when no Content-Length is sent.
    head.push_str("Connection: close\r\n\r\n");

    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    Ok(out)
}

/// Parse a status line, header block, and body.
///
/// `expect_body` is false for a HEAD response, which carries Content-Length but
/// no body. Without it a HEAD would look like a response truncated by exactly
/// its own content length.
pub fn parse_response(bytes: &[u8], expect_body: bool) -> Result<Response> {
    let Some(split) = find(bytes, b"\r\n\r\n") else {
        bail!("quackhole: malformed response (no header terminator)");
    };

    // Only the head is required to be text; the body stays bytes.
    let head = String::from_utf8_lossy(&bytes[..split]);
    let mut lines = head.split("\r\n");

    let mut response = Response::default();
    if let Some(status_line) = lines.next() {
        let mut parts = status_line.splitn(3, ' ');
        let _version = parts.next();
        response.status = parts.next().and_then(|c| c.parse().ok()).unwrap_or(0);
        response.reason = parts.next().unwrap_or("").to_string();
    }
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            response
                .headers
                .push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    let rest = &bytes[split + 4..];
    let chunked = response
        .header("transfer-encoding")
        .is_some_and(|v| v.eq_ignore_ascii_case("chunked"));

    response.body = if !expect_body {
        Vec::new()
    } else if chunked {
        decode_chunked(rest)?
    } else if let Some(len) = response
        .header("content-length")
        .and_then(|v| v.parse::<usize>().ok())
    {
        if len > rest.len() {
            // The stream ended early -- the serving side's bridge died, or the
            // peer was killed mid-response. Clamping here would hand the caller
            // a truncated Parquet/Quack payload as a successful read.
            bail!(
                "quackhole: peer promised {len} body bytes but sent {}",
                rest.len()
            );
        }
        rest[..len].to_vec()
    } else {
        // Everything to stream end, which is well defined because we always
        // send Connection: close.
        rest.to_vec()
    };
    Ok(response)
}

/// First index of `needle` in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn decode_chunked(data: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    while pos < data.len() {
        let Some(line_end) = find(&data[pos..], b"\r\n") else {
            bail!("quackhole: malformed chunked body (unterminated size line)");
        };
        let size_line = String::from_utf8_lossy(&data[pos..pos + line_end]);
        // Strip any chunk extension (";name=value").
        let size_text = size_line.split(';').next().unwrap_or("").trim();
        let Ok(chunk_size) = usize::from_str_radix(size_text, 16) else {
            bail!("quackhole: malformed chunk size {size_text:?}");
        };
        pos += line_end + 2;
        if chunk_size == 0 {
            return Ok(out); // trailers, if any, are ignored
        }
        // Written as a subtraction: `pos + chunk_size` overflows for a chunk
        // size line like "ffffffffffffffee", which would slip past the guard
        // and then wind `pos` backwards into an infinite re-scan.
        if chunk_size > data.len() - pos {
            bail!("quackhole: chunk size runs past the end of the body");
        }
        out.extend_from_slice(&data[pos..pos + chunk_size]);
        pos += chunk_size;
        // Skip the CRLF that terminates the chunk.
        pos = (pos + 2).min(data.len());
    }
    bail!("quackhole: chunked body ended before its terminating chunk")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req<'a>(headers: Vec<(String, String)>, body: Option<&'a [u8]>) -> Request<'a> {
        Request {
            method: "POST",
            path: "/quack",
            host: "peer.iroh",
            port: "9494",
            headers,
            body,
            content_type: "",
        }
    }

    #[test]
    fn framing_headers_are_ours_alone() {
        // A caller that reinstates these breaks the end-of-response signal, so
        // they are dropped rather than merged.
        let headers = vec![
            ("Connection".into(), "keep-alive".into()),
            ("Content-Length".into(), "999".into()),
            ("Host".into(), "evil.example".into()),
            ("Transfer-Encoding".into(), "chunked".into()),
            ("X-Keep".into(), "yes".into()),
        ];
        let out = String::from_utf8(build_request(&req(headers, Some(b"hi"))).unwrap()).unwrap();
        assert_eq!(out.matches("Connection:").count(), 1);
        assert!(out.contains("Connection: close\r\n"));
        assert_eq!(out.matches("Content-Length:").count(), 1);
        assert!(out.contains("Content-Length: 2\r\n"));
        assert!(out.contains("Host: peer.iroh:9494\r\n"));
        assert!(!out.contains("evil.example"));
        assert!(!out.to_lowercase().contains("transfer-encoding"));
        assert!(out.contains("X-Keep: yes\r\n"));
        assert!(out.ends_with("\r\n\r\nhi"));
    }

    #[test]
    fn crlf_in_a_header_cannot_inject_a_second_request() {
        let headers = vec![("X-Bad".into(), "a\r\nConnection: keep-alive".into())];
        assert!(build_request(&req(headers, None)).is_err());

        let mut r = req(Vec::new(), None);
        r.path = "/quack\r\nHost: evil";
        assert!(build_request(&r).is_err());
    }

    #[test]
    fn a_bodyless_request_declares_no_length() {
        let out = String::from_utf8(build_request(&req(Vec::new(), None)).unwrap()).unwrap();
        assert!(!out.contains("Content-Length"));
        assert!(!out.contains("Content-Type"));
    }

    #[test]
    fn content_type_defaults_but_the_caller_wins() {
        let out = String::from_utf8(build_request(&req(Vec::new(), Some(b"x"))).unwrap()).unwrap();
        assert!(out.contains("Content-Type: application/octet-stream\r\n"));

        let headers = vec![("Content-Type".into(), "application/json".into())];
        let out = String::from_utf8(build_request(&req(headers, Some(b"x"))).unwrap()).unwrap();
        assert!(out.contains("application/json"));
        assert!(!out.contains("octet-stream"));
    }

    #[test]
    fn content_length_frames_the_body() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhellotrailing-garbage";
        let res = parse_response(raw, true).unwrap();
        assert_eq!(res.status, 200);
        assert_eq!(res.reason, "OK");
        assert_eq!(res.body, b"hello");
    }

    #[test]
    fn a_body_without_content_length_runs_to_the_end() {
        // The normal case: we send Connection: close and read to stream end.
        let raw = b"HTTP/1.1 200 OK\r\n\r\neverything after the head";
        assert_eq!(
            parse_response(raw, true).unwrap().body,
            b"everything after the head"
        );
    }

    #[test]
    fn chunked_bodies_decode_including_extensions() {
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;a=b\r\nhello\r\n5\r\nworld\r\n0\r\n\r\n";
        assert_eq!(parse_response(raw, true).unwrap().body, b"helloworld");
    }

    #[test]
    fn an_oversized_chunk_size_is_rejected_rather_than_wrapping() {
        // pos + chunk_size overflows here; a guard written that way would let
        // this through and then re-scan forever.
        let raw =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nffffffffffffffee\r\nhi\r\n";
        assert!(parse_response(raw, true).is_err());
    }

    #[test]
    fn a_status_line_we_cannot_read_is_status_zero_not_an_error() {
        // The caller distinguishes "no usable response" from "a response with a
        // status we did not like", so this must not throw.
        let res = parse_response(b"garbage\r\n\r\nbody", true).unwrap();
        assert_eq!(res.status, 0);
    }

    #[test]
    fn a_short_body_is_an_error_rather_than_a_silent_truncation() {
        // Handing this back as a successful read would give the caller a
        // truncated Quack payload it has no way to notice.
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nonly this much";
        let err = parse_response(raw, true).unwrap_err().to_string();
        assert!(err.contains("promised 100"), "got: {err}");
    }

    #[test]
    fn a_head_response_has_no_body_despite_its_content_length() {
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n";
        let res = parse_response(raw, false).unwrap();
        assert_eq!(res.status, 200);
        assert!(res.body.is_empty());
    }

    #[test]
    fn a_response_with_no_header_terminator_is_an_error() {
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n", true).is_err());
    }
}
