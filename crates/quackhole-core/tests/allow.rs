//! The allow list is the only access control quackhole itself enforces -- Quack's
//! token is the other half, and it lives inside the tunnel. This exercises both
//! directions: an allowed peer gets through, a rejected one does not.
//!
//! Needs the network (address lookup), so it is gated like the other live tests.

use quackhole_core::Core;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::{Duration, Instant};

const BODY: &str = "allowed";

fn skip() -> bool {
    if std::env::var("QUACKHOLE_NET_TESTS").as_deref() == Ok("1") {
        return false;
    }
    eprintln!("skipping: set QUACKHOLE_NET_TESTS=1 to run live-network tests");
    true
}

/// Answers any number of requests with a fixed response, then closes each one.
fn spawn_http_server() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
    let addr = listener.local_addr().expect("addr").to_string();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                let _ = stream.read(&mut buf);
                let response = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    BODY.len(),
                    BODY
                );
                let _ = stream.write_all(response.as_bytes());
            });
        }
    });
    addr
}

/// Framing comes from the core, so this asserts on a parsed body rather than
/// on the tail of a byte string it had to build itself.
fn request(dialer: &Core, peer: &str) -> anyhow::Result<quackhole_core::Response> {
    let host = format!("{peer}.iroh");
    let req = quackhole_core::Request {
        method: "GET",
        path: "/",
        host: &host,
        port: "9494",
        headers: Vec::new(),
        body: None,
        content_type: "",
    };
    dialer.request(peer, "", &req, Duration::from_secs(20))
}

#[test]
fn allow_list_admits_the_listed_peer_and_rejects_others() {
    if skip() {
        return;
    }

    let dialer = Core::new(None, true).expect("dialer");
    let dialer_id = dialer.endpoint_id_z32().to_string();

    // --- allowed ---------------------------------------------------------
    let permitted = Core::new(None, true).expect("permitted core");
    permitted
        .serve_start(&spawn_http_server(), vec![dialer_id.clone()])
        .expect("serve");
    let permitted_id = permitted.endpoint_id_z32().to_string();

    // Retry only here: this loop absorbs address-lookup propagation, so a
    // failure in the denied case below cannot be blamed on timing.
    let deadline = Instant::now() + Duration::from_secs(60);
    let response = loop {
        match request(&dialer, &permitted_id) {
            Ok(response) => break response,
            Err(err) if Instant::now() < deadline => {
                eprintln!("retrying after: {err:#}");
                std::thread::sleep(Duration::from_secs(2));
            }
            Err(err) => panic!("allowed peer was refused: {err:#}"),
        }
    };
    assert_eq!(response.status, 200);
    assert_eq!(
        response.body,
        BODY.as_bytes(),
        "allowed peer did not get the response"
    );

    // --- denied ----------------------------------------------------------
    // A different endpoint id, so the dialer is definitively not on the list.
    let stranger = Core::new(None, true)
        .expect("stranger")
        .endpoint_id_z32()
        .to_string();
    let denied = Core::new(None, true).expect("denied core");
    denied
        .serve_start(&spawn_http_server(), vec![stranger])
        .expect("serve");
    let denied_id = denied.endpoint_id_z32().to_string();

    let err = loop {
        match request(&dialer, &denied_id) {
            Ok(_) => panic!("allow list did not reject an unlisted peer"),
            Err(err) => {
                let text = format!("{err:#}");
                // Distinguish a real rejection from "not resolvable yet": the
                // reject path closes the connection with this exact reason, so
                // asserting on it means a propagation delay cannot pass as a
                // successful denial.
                if text.contains("not on allow list") || Instant::now() >= deadline {
                    break text;
                }
                eprintln!("waiting for lookup: {text}");
                std::thread::sleep(Duration::from_secs(2));
            }
        }
    };
    assert!(
        err.contains("not on allow list"),
        "rejected for the wrong reason: {err}"
    );

    permitted
        .serve_stop(Duration::from_secs(5))
        .expect("stop permitted");
    denied
        .serve_stop(Duration::from_secs(5))
        .expect("stop denied");
}

#[test]
fn empty_allow_list_admits_anyone() {
    if skip() {
        return;
    }

    let serving = Core::new(None, true).expect("serving");
    serving
        .serve_start(&spawn_http_server(), Vec::new())
        .expect("serve");
    let peer = serving.endpoint_id_z32().to_string();

    let dialer = Core::new(None, true).expect("dialer");
    let deadline = Instant::now() + Duration::from_secs(60);
    let response = loop {
        match request(&dialer, &peer) {
            Ok(response) => break response,
            Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_secs(2)),
            Err(err) => panic!("no allow list should mean no restriction: {err:#}"),
        }
    };
    assert_eq!(response.body, BODY.as_bytes());

    serving.serve_stop(Duration::from_secs(5)).expect("stop");
}

#[test]
fn a_malformed_allow_list_entry_fails_the_call() {
    if skip() {
        return;
    }
    let serving = Core::new(None, true).expect("serving");
    // Parsed up front, so a typo is an error the caller sees rather than a
    // silent "nobody can connect".
    let err = serving
        .serve_start(
            "127.0.0.1:9494",
            vec!["obviously-not-an-endpoint-id".to_string()],
        )
        .unwrap_err();
    assert!(format!("{err:#}").contains("allow list"), "got: {err:#}");
    assert!(!serving.is_serving());
}
