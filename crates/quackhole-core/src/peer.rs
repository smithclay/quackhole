//! Peer identity: everything one machine needs in order to reach another.
//!
//! Endpoint id, relay URL and token travel together because they are only ever
//! useful together, and every spelling derived from them -- the ticket, the
//! `quack:` address, the secret's name -- is written here and nowhere else.
//!
//! This exists for the same reason `http.rs` does. Both clients link this
//! crate, so a shape defined here cannot drift; a shape defined in the C++ and
//! again in the JavaScript already had, four times over. See the framing bullet
//! in `CLAUDE.md` for the precedent.

use crate::parse_endpoint_id;
use anyhow::{Result, bail};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::{Deserialize, Serialize};

/// The port a Quack server listens on, and therefore the one every address
/// names. `quackhole_serve`'s `target` can move the *local* Quack, but the
/// address a peer dials is the tunnel's far end, which is always this.
pub const QUACK_PORT: &str = "9494";

/// Version marker. A future field changes this rather than being guessed at.
const TICKET_PREFIX: &str = "qh1_";

/// The last label of an address we own. Nothing resolves it -- quackhole
/// intercepts before a socket exists.
const IROH_SUFFIX: &str = ".iroh";

/// Prefixed rather than bare: z-base-32 includes digits, so an endpoint id is
/// not always a valid unquoted DuckDB identifier.
const SECRET_PREFIX: &str = "qh_";

/// The wire form of a ticket. Single-letter keys because this is base64'd into
/// a URL fragment and every byte is one a person may have to copy by hand.
#[derive(Serialize, Deserialize)]
struct TicketJson {
    e: String,
    #[serde(default)]
    r: String,
    #[serde(default)]
    t: String,
}

/// One remote DuckDB, as the local one knows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    endpoint_id: String,
    relay_url: String,
    token: String,
}

impl Peer {
    /// Validate an endpoint id and pair it with a relay and token.
    ///
    /// The id is normalised to z-base-32 whatever form it arrived in. That is
    /// not cosmetic: `address()` puts it in a DNS label, and hex is 64
    /// characters where a label allows 63.
    pub fn new(endpoint_id: &str, relay_url: &str, token: &str) -> Result<Self> {
        Ok(Self {
            endpoint_id: parse_endpoint_id(endpoint_id)?.to_z32(),
            relay_url: relay_url.trim().to_string(),
            token: token.to_string(),
        })
    }

    pub fn endpoint_id(&self) -> &str {
        &self.endpoint_id
    }

    pub fn relay_url(&self) -> &str {
        &self.relay_url
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// The address a client dials.
    ///
    /// `ATTACH` and the secret's `SCOPE` have to agree on this string exactly,
    /// or the token is filed under a path nothing attaches to and the failure
    /// reads `Could not find a Quack authentication token` rather than as a
    /// typo. One function is what makes them unable to disagree.
    pub fn address(&self) -> String {
        format!("quack:{}{IROH_SUFFIX}:{QUACK_PORT}", self.endpoint_id)
    }

    /// A DuckDB identifier naming this peer's secret.
    ///
    /// Derived from the endpoint id rather than fixed, because an unnamed quack
    /// secret is really `__default_quack`: a second `CREATE SECRET` fails on the
    /// name whatever its scope says.
    pub fn secret_name(&self) -> String {
        format!("{SECRET_PREFIX}{}", self.endpoint_id)
    }

    /// `qh1_` + base64url of `{"e": id, "r": relay, "t": token}`.
    ///
    /// One token with no spaces, so it survives a copy out of a terminal and a
    /// paste into an input without a half-selection truncating it quietly.
    ///
    /// Refuses when there is no relay. A ticket without one sends the holder to
    /// pkarr -- a round trip to a third party that must also have seen this
    /// endpoint publish, which a server started seconds ago routinely has not
    /// -- so it fails on the first click. No ticket beats a broken one.
    pub fn to_ticket(&self) -> Result<String> {
        if self.relay_url.is_empty() {
            bail!(
                "cannot mint a ticket without a relay url: the holder would have to \
                 resolve this endpoint through pkarr, which routinely has not seen a \
                 server this new"
            );
        }
        let json = serde_json::to_string(&TicketJson {
            e: self.endpoint_id.clone(),
            r: self.relay_url.clone(),
            t: self.token.clone(),
        })?;
        Ok(format!("{TICKET_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
    }

    /// Read a ticket back.
    ///
    /// Generous about what arrives: people copy the surrounding quotes, the
    /// shell prompt, or the whole line, so the first thing shaped like a ticket
    /// is pulled out rather than the paste being rejected.
    ///
    /// Every error here is written for the person holding the ticket. They land
    /// in a browser's error slot and in a DuckDB error message, and in both
    /// places the reader is someone who just pasted something.
    pub fn parse_ticket(input: &str) -> Result<Self> {
        let raw = input.trim();
        if raw.is_empty() {
            bail!("Paste the ticket your laptop printed.");
        }

        let Some(found) = find_ticket(raw) else {
            bail!(if raw.len() < 60 && !raw.contains(' ') {
                "That looks like an endpoint id, not a ticket. The ticket starts with \
                     qh1_ and also carries the relay and token."
            } else {
                "No ticket in that text. Look for the string starting with qh1_."
            });
        };

        let decoded = URL_SAFE_NO_PAD
            .decode(&found[TICKET_PREFIX.len()..])
            .ok()
            .and_then(|bytes| serde_json::from_slice::<TicketJson>(&bytes).ok());
        let Some(ticket) = decoded else {
            bail!(
                "That ticket is damaged -- it decodes to nothing. Copy the whole qh1_ \
                 string and try again."
            );
        };

        if ticket.e.is_empty() {
            bail!("That ticket has no endpoint id in it.");
        }
        // The one failure that looks fine and then hangs, so refuse it by name.
        if ticket.r.is_empty() {
            bail!(
                "That ticket was minted before the endpoint knew its relay. Re-run the \
                 ticket line on your laptop."
            );
        }
        Self::new(&ticket.e, &ticket.r, &ticket.t)
    }

    /// The endpoint id in an `<id>.iroh` address, or None if it is not one.
    ///
    /// Accepts anything a caller happens to hold: a bare hostname, a
    /// `host:port`, or a full `quack:`/`https:` URL with a path. That breadth is
    /// why this is one function -- the C++ is handed `https://<id>.iroh:9494`
    /// and the browser is handed a `URL.hostname`, and neither should own a
    /// second reading of the same convention.
    ///
    /// Deliberately lexical: it does not check that the id is a real key.
    /// Validation belongs at dial time, where `parse_endpoint_id` already does
    /// it -- and a `.iroh` host with a broken id must still be recognised as
    /// ours, or it falls through to httpfs and fails at `getaddrinfo` instead
    /// of saying what is wrong.
    pub fn parse_address(address: &str) -> Option<String> {
        let mut value = address.trim();
        if let Some(at) = value.find("://") {
            value = &value[at + 3..];
        } else if let Some(at) = value.find(':') {
            // A scheme with no slashes, as in `quack:<id>.iroh:9494`. Only the
            // first colon can be one; the rest introduce the port.
            let head = &value[..at];
            if !head.is_empty()
                && !head.contains('.')
                && head.chars().all(|c| c.is_ascii_alphabetic())
            {
                value = &value[at + 1..];
            }
        }
        if let Some(at) = value.find('/') {
            value = &value[..at];
        }
        if let Some(at) = value.rfind(':') {
            value = &value[..at];
        }
        // Case-insensitive on the label, case-preserving on the id: DuckDB
        // hands the host over as the user typed it, and the id is a key.
        if !value.to_ascii_lowercase().ends_with(IROH_SUFFIX) {
            return None;
        }
        let id = &value[..value.len() - IROH_SUFFIX.len()];
        if id.is_empty() {
            return None;
        }
        Some(id.to_string())
    }
}

/// The first `qh1_…` run in `text`, if any.
///
/// Hand-rolled rather than a regex crate: this is the only pattern in the
/// workspace, and it is one the browser build would otherwise pay for.
fn find_ticket(text: &str) -> Option<&str> {
    let at = text.find(TICKET_PREFIX)?;
    let rest = &text[at + TICKET_PREFIX.len()..];
    let len = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .unwrap_or(rest.len());
    if len == 0 {
        return None;
    }
    Some(&text[at..at + TICKET_PREFIX.len() + len])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real key, so the id survives the z-base-32 round trip in `new`.
    fn some_id() -> String {
        iroh::SecretKey::generate().public().to_z32()
    }

    #[test]
    fn a_ticket_round_trips() {
        let peer = Peer::new(&some_id(), "https://relay.example/", "tok").unwrap();
        let ticket = peer.to_ticket().unwrap();
        assert!(ticket.starts_with(TICKET_PREFIX));
        // No character that a URL fragment, a shell copy or a double-click
        // selection would break on.
        assert!(
            ticket[TICKET_PREFIX.len()..]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        );
        assert_eq!(Peer::parse_ticket(&ticket).unwrap(), peer);
    }

    #[test]
    fn a_token_carrying_json_punctuation_survives() {
        // The one field a caller controls: endpoint ids are z-base-32 and
        // relays are URLs, but `token :=` is whatever was typed.
        let peer = Peer::new(&some_id(), "https://relay.example/", r#"a"b\c'd"#).unwrap();
        let back = Peer::parse_ticket(&peer.to_ticket().unwrap()).unwrap();
        assert_eq!(back.token(), r#"a"b\c'd"#);
    }

    #[test]
    fn a_ticket_is_found_in_whatever_it_was_pasted_inside() {
        let peer = Peer::new(&some_id(), "https://relay.example/", "tok").unwrap();
        let ticket = peer.to_ticket().unwrap();
        for wrapper in [
            format!("  {ticket}  "),
            format!("'{ticket}'"),
            format!("https://example.test/quackhole/#{ticket}"),
            format!("$ open 'https://x/#{ticket}'\n"),
        ] {
            assert_eq!(Peer::parse_ticket(&wrapper).unwrap(), peer, "in {wrapper}");
        }
    }

    #[test]
    fn a_relayless_ticket_is_refused_at_both_ends() {
        let id = some_id();
        // Minting: the holder would be sent to pkarr and fail on first click.
        assert!(Peer::new(&id, "", "tok").unwrap().to_ticket().is_err());
        // Parsing: and if one was minted by an older encoder, say so by name
        // rather than letting it hang.
        let json = format!(r#"{{"e":"{id}","r":"","t":"tok"}}"#);
        let ticket = format!("{TICKET_PREFIX}{}", URL_SAFE_NO_PAD.encode(json));
        let err = Peer::parse_ticket(&ticket).unwrap_err().to_string();
        assert!(err.contains("relay"), "{err}");
    }

    #[test]
    fn bad_tickets_say_which_kind_of_bad() {
        let cases = [
            ("", "Paste the ticket"),
            (
                "k2wxsz6ynqcmz4pdm6cnzpgqtnryzntitr8sy6kt5xqrujwd7nqo",
                "endpoint id, not a ticket",
            ),
            (
                "nothing here at all, just some prose about tickets",
                "Look for the string",
            ),
            ("qh1_!!!!", "endpoint id, not a ticket"),
            ("qh1_bm90anNvbg", "damaged"),
        ];
        for (input, want) in cases {
            let err = Peer::parse_ticket(input).unwrap_err().to_string();
            assert!(
                err.contains(want),
                "{input:?} said {err:?}, wanted {want:?}"
            );
        }
    }

    #[test]
    fn the_scope_and_the_attach_path_cannot_drift() {
        // This is the whole reason `address()` exists: Quack looks a secret up
        // by the ATTACH path, and a scope that disagrees is not "wrong scope",
        // it is "no token found".
        let peer = Peer::new(&some_id(), "https://relay.example/", "tok").unwrap();
        assert_eq!(peer.address(), peer.address());
        assert!(peer.address().starts_with("quack:"));
        assert!(peer.address().ends_with(".iroh:9494"));
        assert_eq!(
            Peer::parse_address(&peer.address()).as_deref(),
            Some(peer.endpoint_id())
        );
    }

    #[test]
    fn an_address_is_read_in_every_form_a_caller_holds_one() {
        // C++ is handed a proto_host_port, the browser a URL.hostname, and a
        // person types whatever they saw.
        for input in [
            "abc.iroh",
            "abc.iroh:9494",
            "quack:abc.iroh:9494",
            "https://abc.iroh:9494",
            "https://abc.iroh:9494/quack",
            "  abc.iroh:9494  ",
        ] {
            assert_eq!(
                Peer::parse_address(input).as_deref(),
                Some("abc"),
                "{input}"
            );
        }
        for input in [
            "localhost:9494",
            "quack:localhost:9494",
            "",
            ".iroh",
            "iroh",
        ] {
            assert_eq!(Peer::parse_address(input), None, "{input}");
        }
        // The label is matched case-insensitively -- DuckDB passes the host on
        // as typed -- but the id is a key, so its case is left alone.
        assert_eq!(
            Peer::parse_address("https://AbC.IROH:9494").as_deref(),
            Some("AbC")
        );
    }

    #[test]
    fn an_endpoint_id_is_normalised_to_something_that_fits_a_dns_label() {
        // Hex is 64 characters and a label allows 63, so an address built from
        // an unnormalised id would be one nothing can carry.
        let key = iroh::SecretKey::generate().public();
        let from_hex = Peer::new(&key.to_string(), "https://r.example/", "t").unwrap();
        let from_z32 = Peer::new(&key.to_z32(), "https://r.example/", "t").unwrap();
        assert_eq!(from_hex, from_z32);
        assert_eq!(from_hex.endpoint_id().len(), 52);
    }

    #[test]
    fn a_secret_name_is_a_bare_identifier() {
        let peer = Peer::new(&some_id(), "https://r.example/", "t").unwrap();
        let name = peer.secret_name();
        // Interpolated unquoted into SQL, so nothing here may need escaping --
        // and it must not start with a digit, which a bare z-base-32 id can.
        assert!(name.starts_with(SECRET_PREFIX));
        assert!(name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        assert!(!name.chars().next().unwrap().is_ascii_digit());
    }
}
