//! The relay a peer is reached through belongs to that peer.
//!
//! Registering one is what lets a native client hold two remotes on two relays,
//! which is the thing a single `quackhole_relay_url` setting could not describe.
//! `quackhole_attach` fills this in from the ticket.
//!
//! Binding an endpoint opens a UDP socket and publishes an address, so this is
//! gated like the other live tests.

use quackhole_core::Core;
use std::time::Duration;

fn skip() -> bool {
    if std::env::var("QUACKHOLE_NET_TESTS").as_deref() == Ok("1") {
        return false;
    }
    eprintln!("skipping: set QUACKHOLE_NET_TESTS=1 to run live-network tests");
    true
}

#[test]
fn a_relay_is_registered_per_peer_and_validated_up_front() {
    if skip() {
        return;
    }
    let mut core = Core::new(None, true).expect("bind endpoint");
    // Any valid endpoint id will do -- nothing is dialled here.
    let peer = Core::new(None, true).expect("bind peer");
    let id = peer.endpoint_id_z32().to_string();

    core.set_peer_relay(&id, "https://relay.example./")
        .expect("register");

    // Rejected at registration rather than at dial time. An unusable relay
    // accepted here surfaces as a failure on some later query, a long way from
    // the ATTACH that supplied it.
    let err = core
        .set_peer_relay(&id, "not a url at all")
        .expect_err("a bad relay url must not be accepted");
    assert!(format!("{err:#}").contains("relay url"), "{err:#}");

    // And a bad endpoint id is refused for the same reason: an address nothing
    // will ever dial is silently useless.
    assert!(
        core.set_peer_relay("not-an-endpoint-id", "https://relay.example./")
            .is_err()
    );

    // Empty forgets the peer rather than registering nothing, so a relay-less
    // handoff does not leave a stale relay in place.
    core.set_peer_relay(&id, "").expect("forget");

    let mut peer = peer;
    peer.shutdown(Duration::from_secs(2));
    core.shutdown(Duration::from_secs(2));
}
