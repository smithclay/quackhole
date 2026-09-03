//! End-to-end transport test: one Core serves, another dials it by endpoint id.
//!
//! Dialing a bare endpoint id goes through n0's pkarr/DNS address lookup, so
//! this test needs the network and a few seconds of publish propagation. It is
//! gated behind QUACKHOLE_NET_TESTS=1 to keep `cargo test` hermetic, mirroring
//! the `require-env` idiom used for live tests in DuckDB extensions.

use quackhole_core::Core;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::time::{Duration, Instant};

const BODY: &str = "quack-over-iroh";

/// A GET for the peer's root. Framing comes from the core, so this test no
/// longer hand-writes HTTP -- which also means it exercises the same builder
/// the extension uses rather than a lookalike.
fn get(peer: &str) -> quackhole_core::Request<'static> {
    // Leaked so the borrow outlives the retry loop below; this is a test.
    let host: &'static str = Box::leak(format!("{peer}.iroh").into_boxed_str());
    quackhole_core::Request {
        method: "GET",
        path: "/",
        host,
        port: "9494",
        headers: Vec::new(),
        body: None,
        content_type: "",
    }
}

/// A one-shot HTTP/1.1 server: read a request, reply, close.
///
/// Closing is what turns the loopback TCP FIN into a QUIC stream FIN, which is
/// how the dialing side knows the response ended.
///
/// The request it read is sent back over the channel. It stands in for Quack, so
/// what reaches it is what the bridge forwarded -- which is the only place the
/// request can be inspected after a real round trip.
fn spawn_http_server() -> (String, mpsc::Receiver<String>, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr").to_string();
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        for stream in listener.incoming().take(1) {
            let mut stream = match stream {
                Ok(s) => s,
                Err(_) => return,
            };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                BODY.len(),
                BODY
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.flush();
        }
    });
    (addr, rx, handle)
}

#[test]
fn request_round_trips_over_iroh() {
    if std::env::var("QUACKHOLE_NET_TESTS").as_deref() != Ok("1") {
        eprintln!("skipping: set QUACKHOLE_NET_TESTS=1 to run live-network tests");
        return;
    }

    let (target, requests, server) = spawn_http_server();

    let serving = Core::new(None, true, "").expect("serving core");
    serving.serve_start(&target, Vec::new()).expect("serve");
    let peer_id = serving.endpoint_id_z32().to_string();
    assert_eq!(peer_id.len(), 52, "z-base-32 endpoint id fits a DNS label");

    let dialing = Core::new(None, true, "").expect("dialing core");

    // Address lookup has to propagate before the dial can resolve the id.
    let deadline = Instant::now() + Duration::from_secs(60);
    let response = loop {
        match dialing.request(&peer_id, "", &get(&peer_id), Duration::from_secs(20)) {
            Ok(response) => break response,
            Err(err) if Instant::now() < deadline => {
                eprintln!("retrying after: {err:#}");
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(err) => panic!("request failed: {err:#}"),
        }
    };

    assert_eq!(response.status, 200);
    // Decoded, and byte-identical. Both ends are compressing here -- the client
    // asked below and the bridge answered -- so this is also the assertion that
    // the envelope survives a real iroh round trip rather than only a Vec.
    assert_eq!(response.body, BODY.as_bytes());

    // What Quack was handed. The header has to reach it: a bridge that consumed
    // the head while sniffing it, or forwarded it short, would still return this
    // body and fail only against a real Quack.
    let seen = requests
        .recv_timeout(Duration::from_secs(5))
        .expect("request");
    assert!(
        seen.to_ascii_lowercase()
            .contains("x-quackhole-accept-encoding: gzip"),
        "the client asked for a compressed response: {seen:?}"
    );
    assert!(
        seen.starts_with("GET / HTTP/1.1\r\n") && seen.ends_with("\r\n\r\n"),
        "and the head arrived whole: {seen:?}"
    );

    let peers = dialing.peer_snapshot();
    assert_eq!(peers.len(), 1);
    assert_eq!(peers[0].1.direction, "out");

    serving.serve_stop(Duration::from_secs(5)).expect("stop");
    let _ = server.join();
}
