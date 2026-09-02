//! Compression of the response half of a Quack exchange.
//!
//! Quack answers in `application/vnd.duckdb`, which is DuckDB's own
//! serialisation and is not compressed: measured against a live `quack_serve`,
//! 15.8 MB of real responses gzip to 5.2 MB at level 6 and 5.6 MB at level 1.
//! Every one of those bytes crosses a relay somebody else runs, so this is the
//! cheapest thing available -- roughly a third of the wire, for CPU that a relay
//! leg dwarfs.
//!
//! Here rather than in the C++ or the browser client for the same reason the
//! HTTP framing is: both clients link this crate and drive it, so the envelope,
//! the header that asks for it and the magic that announces it are one
//! definition. Two would drift, and the failure mode of a drifted envelope is a
//! peer handed a gzip stream it reads as DuckDB's wire format.
//!
//! # Why a quackhole envelope rather than `Content-Encoding`
//!
//! `Content-Encoding` is the origin server's to set, and the origin server here
//! is Quack's cpp-httplib, which does not compress. Asking it to with
//! `Accept-Encoding` would be asking a question nothing answers -- and would be
//! actively unsafe the day it starts answering, because `parse_response` decodes
//! no content coding and would hand Quack a gzip stream as a result set.
//!
//! So what compresses is quackhole's own bridge, and what it compresses is the
//! whole response *stream* -- status line, headers and body together -- wrapped
//! in an envelope belonging to this transport. The head is a few hundred bytes
//! and compresses well, but that is not the reason: it means the bridge never
//! parses the response, so it stays the byte pipe it is today.
//!
//! # Why only the response
//!
//! Asymmetry on purpose. The response is where the bytes are -- a request is a
//! query, a response is the rows -- and compressing only one direction means one
//! side advertises and the other decides, which is a negotiation with a single
//! round trip and no state. An INSERT with a large body would benefit, and is
//! left for whoever measures it.

use anyhow::{Context, Result};
use flate2::Compression;
use flate2::read::GzDecoder;
use std::io::Read;

/// What a client sends to say it can read a compressed response.
///
/// Not `Accept-Encoding`, which means something else and is addressed to
/// somebody else -- see the module note. A server that has never heard of this
/// forwards it to Quack, which ignores headers it does not know, so an old
/// server answers an asking client exactly as it always did.
pub const ACCEPT_HEADER: &str = "X-Quackhole-Accept-Encoding";

/// The one coding, and the only value the header is ever given.
pub const ACCEPT_VALUE: &str = "gzip";

/// Marks a response stream as enveloped.
///
/// A leading NUL is what makes this unambiguous: an HTTP response begins
/// `HTTP/`, so no uncompressed reply can be mistaken for one of these, and a
/// client that asked for compression and got none needs no flag to tell the
/// difference. That is what lets a new client talk to an old server.
pub const MAGIC: &[u8] = b"\x00QHZ1";

/// Level 1, and deliberately the cheapest one.
///
/// The measurement that matters is the ratio against the relay, not against
/// another level: level 6 gets 3.02x and level 1 gets 2.84x on real Quack
/// responses, which is six percent of the wire for several times the CPU. The
/// serving side is somebody's laptop with a DuckDB on it, and it is answering
/// queries with the same cores.
const LEVEL: Compression = Compression::new(1);

/// Where a request's header block ends, if all of it has arrived.
///
/// The bridge needs this to know how much of what it has read is head, because
/// a body may share the first packet with it -- and a body is caller data. An
/// INSERT of a log line that happens to contain this header's name must not
/// turn compression on for a client that cannot read it.
pub fn head_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4)
}

/// Does this request head ask for a compressed response?
///
/// Reads the head as bytes rather than as a parsed message: the bridge is a byte
/// pipe and this is the one question it asks of what passes through, so turning
/// the stream into a request and back would be a whole HTTP implementation on
/// the serving side -- the second one, after `http.rs`.
///
/// Case-insensitive on the name, per RFC 9110, and the value is checked so a
/// future coding this server does not have cannot be answered as if it did.
pub fn wants_compression(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    // `split` and not `lines`: a header block is CRLF-delimited and a bare LF
    // inside it is not a header boundary.
    text.split("\r\n").any(|line| {
        line.split_once(':').is_some_and(|(name, value)| {
            name.trim().eq_ignore_ascii_case(ACCEPT_HEADER)
                && value
                    .split(',')
                    .any(|v| v.trim().eq_ignore_ascii_case(ACCEPT_VALUE))
        })
    })
}

/// A gzip encoder that hands back whatever it has finished with.
///
/// Wrapped around a `Vec` rather than around the QUIC stream, because the stream
/// is async and flate2 is not. The bridge feeds it a chunk at a time and drains
/// what comes out, which keeps the response streaming: nothing waits for the
/// whole result set to exist before any of it is on the wire.
#[derive(Debug)]
pub struct Encoder {
    inner: flate2::write::GzEncoder<Vec<u8>>,
    /// False until the magic has been handed out, so it prefixes the stream
    /// exactly once and the caller cannot forget to write it.
    started: bool,
}

impl Default for Encoder {
    fn default() -> Self {
        Self::new()
    }
}

impl Encoder {
    pub fn new() -> Self {
        Self {
            inner: flate2::write::GzEncoder::new(Vec::new(), LEVEL),
            started: false,
        }
    }

    /// Compress `chunk` and return whatever is ready to go out.
    ///
    /// May be empty: gzip buffers, and a small chunk usually produces nothing at
    /// all. An empty result is not end of stream -- `finish` is.
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<u8>> {
        use std::io::Write;
        self.inner
            .write_all(chunk)
            .context("failed to compress response")?;
        Ok(self.take())
    }

    /// Flush the trailer and return the last bytes of the stream.
    pub fn finish(mut self) -> Result<Vec<u8>> {
        let mut out = std::mem::take(self.inner.get_mut());
        let rest = self
            .inner
            .finish()
            .context("failed to finish compressing")?;
        out.extend_from_slice(&rest);
        Ok(with_magic(&mut self.started, out))
    }

    fn take(&mut self) -> Vec<u8> {
        let out = std::mem::take(self.inner.get_mut());
        with_magic(&mut self.started, out)
    }
}

/// Prefix the first non-empty write with the magic, and only the first.
fn with_magic(started: &mut bool, out: Vec<u8>) -> Vec<u8> {
    if *started || out.is_empty() {
        return out;
    }
    *started = true;
    let mut framed = MAGIC.to_vec();
    framed.extend_from_slice(&out);
    framed
}

/// Undo the envelope, if there is one.
///
/// A response with no magic is returned untouched, which is the whole
/// compatibility story: a server that predates this never compresses, and a
/// client that asked and was answered plainly cannot tell the difference and
/// does not need to.
pub fn decode(raw: Vec<u8>) -> Result<Vec<u8>> {
    if !raw.starts_with(MAGIC) {
        return Ok(raw);
    }
    let mut out = Vec::new();
    GzDecoder::new(&raw[MAGIC.len()..])
        .read_to_end(&mut out)
        // A truncated or corrupt envelope is a failure and not a fallback. The
        // bytes underneath are a result set, and handing a caller half of one as
        // if it were all of it is the failure this refuses to have.
        //
        // Nothing else is checked here, and nothing else needs to be: gzip ends
        // in a CRC and a length, so a stream that was cut short fails on its own
        // rather than decoding to a shorter answer. An empty result decodes to
        // nothing legitimately -- that is a HEAD, or a peer that said nothing.
        .context("failed to decompress the peer's response")?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(headers: &str) -> Vec<u8> {
        format!("GET / HTTP/1.1\r\nHost: x.iroh:9494\r\n{headers}\r\n").into_bytes()
    }

    #[test]
    fn a_client_that_asks_is_heard() {
        assert!(wants_compression(&head(
            "X-Quackhole-Accept-Encoding: gzip\r\n"
        )));
    }

    #[test]
    fn the_header_name_is_case_insensitive() {
        // RFC 9110: field names are case-insensitive, and nothing guarantees a
        // future client spells it the way this one does.
        assert!(wants_compression(&head(
            "x-quackhole-accept-encoding: GZIP\r\n"
        )));
    }

    #[test]
    fn a_client_that_does_not_ask_is_not_compressed_at() {
        // The old-client case, and the one that has to keep working: a peer that
        // has never heard of the envelope must be answered in plain HTTP.
        assert!(!wants_compression(&head("Accept: */*\r\n")));
        assert!(!wants_compression(&head("")));
    }

    #[test]
    fn a_coding_this_server_does_not_have_is_not_claimed() {
        // The header is a list, and a client that grows a second coding still
        // has to be answered in one this server can actually produce.
        assert!(!wants_compression(&head(
            "X-Quackhole-Accept-Encoding: zstd\r\n"
        )));
        assert!(wants_compression(&head(
            "X-Quackhole-Accept-Encoding: zstd, gzip\r\n"
        )));
    }

    #[test]
    fn the_header_is_only_read_in_the_head() {
        // The caller passes the head alone, which is what keeps a request *body*
        // carrying this text -- an INSERT of a log line, say -- from turning
        // compression on for a client that cannot read it.
        let body =
            b"POST /x HTTP/1.1\r\nContent-Length: 40\r\n\r\nX-Quackhole-Accept-Encoding: gzip\r\n";
        let split = crate::compress::head_end(body).expect("head ends");
        assert!(!wants_compression(&body[..split]));
    }

    #[test]
    fn a_response_round_trips() {
        let payload: Vec<u8> = (0..200_000u32).map(|n| (n % 251) as u8).collect();
        let mut enc = Encoder::new();
        let mut wire = Vec::new();
        for chunk in payload.chunks(8192) {
            wire.extend_from_slice(&enc.push(chunk).expect("push"));
        }
        wire.extend_from_slice(&enc.finish().expect("finish"));

        assert!(wire.starts_with(MAGIC), "the envelope announces itself");
        assert!(wire.len() < payload.len() / 2, "and it is actually smaller");
        assert_eq!(decode(wire).expect("decode"), payload);
    }

    #[test]
    fn an_empty_response_still_carries_the_magic() {
        // A HEAD, or a peer that answered with nothing at all. Without the magic
        // the client would read the gzip header as the start of an HTTP status
        // line, and the error would be about framing rather than about the empty
        // reply it actually was.
        let wire = Encoder::new().finish().expect("finish");
        assert!(wire.starts_with(MAGIC));
        assert!(decode(wire).expect("decode").is_empty());
    }

    #[test]
    fn a_plain_response_is_passed_through_untouched() {
        // The old-server case. Nothing about a plain HTTP reply may be altered
        // by a client that hoped for a compressed one.
        let plain = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi".to_vec();
        assert_eq!(decode(plain.clone()).expect("decode"), plain);
    }

    #[test]
    fn a_corrupt_envelope_is_an_error_and_not_a_shrug() {
        // Quack carries result sets. Half of one returned as though it were all
        // of it is the outcome worth refusing.
        let mut wire = MAGIC.to_vec();
        wire.extend_from_slice(b"this is not a gzip stream");
        assert!(decode(wire).is_err());
    }

    #[test]
    fn a_truncated_envelope_is_an_error() {
        let mut enc = Encoder::new();
        let mut wire = enc.push(&vec![7u8; 100_000]).expect("push");
        wire.extend_from_slice(&enc.finish().expect("finish"));
        wire.truncate(wire.len() - 16);
        assert!(decode(wire).is_err());
    }
}
