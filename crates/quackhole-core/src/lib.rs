//! Transport core for the `quackhole` DuckDB extension.
//!
//! This crate moves opaque bytes between DuckDB processes over iroh QUIC streams.
//! It deliberately knows nothing about HTTP: the C++ side of the extension builds
//! request bytes and parses response bytes, so there is exactly one HTTP
//! implementation and this FFI surface stays small.

mod compress;
mod dial;
mod http;
mod peer;
// Native-only: the C ABI exists for DuckDB, and a browser cannot serve --
// quack_serve itself throws NotImplementedException on wasm.
#[cfg(not(target_family = "wasm"))]
mod ffi;
#[cfg(not(target_family = "wasm"))]
mod serve;

pub use dial::{ConnCache, request_async};
pub use http::{Request, Response, build_request, parse_response};
pub use peer::{Peer, QUACK_PORT};

use anyhow::{Context, Result};
use iroh::EndpointId;
use std::collections::HashMap;
use std::sync::Arc;

#[cfg(not(target_family = "wasm"))]
use iroh::endpoint::presets;
#[cfg(not(target_family = "wasm"))]
use iroh::{Endpoint, SecretKey};
#[cfg(not(target_family = "wasm"))]
use std::path::Path;
#[cfg(not(target_family = "wasm"))]
use std::sync::Mutex;
#[cfg(not(target_family = "wasm"))]
use std::time::Duration;
#[cfg(not(target_family = "wasm"))]
use tokio::runtime::Runtime;

/// ALPN for the Quack-over-iroh bridge. Bumping this is a wire break.
pub const ALPN: &[u8] = b"quackhole/quack/1";

#[cfg(not(target_family = "wasm"))]
/// Owns the tokio runtime, the iroh endpoint, the accept loop (when serving),
/// and the outbound connection cache.
///
/// The runtime is owned by this struct rather than living in a lazy `static`, so
/// that dropping the handle on database close actually stops the reactor.
#[derive(Debug)]
pub struct Core {
    /// `Option` so `shutdown()` can take and time-bound the runtime teardown.
    runtime: Option<Runtime>,
    endpoint: Endpoint,
    endpoint_id_z32: String,
    endpoint_id_hex: String,
    serve: Mutex<Option<serve::ServeHandle>>,
    conns: dial::ConnCache,
    peers: PeerMap,
    /// Where to reach each peer, keyed by endpoint id.
    ///
    /// The browser has always had this (`web/bridge-worker.js`); the native
    /// side had one global `quackhole_relay_url` setting instead, so a second
    /// remote on a second relay was dialled through the first one's. A relay
    /// belongs to a peer, not to a process.
    relays: Mutex<HashMap<EndpointId, String>>,
}

/// What `quackhole_status()` knows about one peer.
#[derive(Debug, Clone)]
pub struct PeerEntry {
    /// "direct" or "relay", or "unknown" before any path is open.
    ///
    /// Both directions report it. The accept side reads it off `IncomingAddr`;
    /// the dial side samples `Connection::paths()` after each round trip, which
    /// is also how an upgrade from relay to direct becomes visible.
    pub path: &'static str,
    /// "in" if the peer dialed us, "out" if we dialed it.
    pub direction: &'static str,
}

pub type PeerMap = Arc<std::sync::Mutex<HashMap<EndpointId, PeerEntry>>>;

/// Parse an endpoint id in any form iroh prints.
///
/// `EndpointId: FromStr` accepts hex and RFC-4648 base32, but NOT z-base-32 --
/// that has its own `from_z32`. We print z-base-32 (52 chars, fits a DNS label,
/// and is what pkarr uses), so a parser that only used `FromStr` would reject
/// our own output. Accept all three so any form a user can paste works.
pub fn parse_endpoint_id(s: &str) -> Result<EndpointId> {
    let trimmed = s.trim();
    if let Ok(id) = trimmed.parse::<EndpointId>() {
        return Ok(id);
    }
    EndpointId::from_z32(trimmed)
        .with_context(|| format!("'{trimmed}' is not a valid iroh endpoint id"))
}

/// Parse one relay URL, rejecting what iroh will accept but cannot dial.
///
/// `RelayUrl: FromStr` is `Url::parse` and nothing more, which is looser than
/// it looks: `relay.example.org:443` parses, reading the host as the *scheme*
/// and the port as the path, and so does `ftp://relay.example./`. Both then
/// bind an endpoint on a relay map nothing can connect to, and the only
/// symptom is a home relay that never arrives -- `quackhole_serve` waits its
/// ten seconds and returns a NULL ticket with the relay setting named nowhere.
/// So the check `Url` does not make is made here, once, for the three callers
/// that take a relay from a person. A host on its own is the mistake worth
/// naming, because it is the one that looks right.
///
/// The scheme is the whole check: http and https are the only ones iroh speaks,
/// and both are "special" schemes, which the URL parser already refuses to
/// accept without a host.
pub fn parse_relay_url(input: &str) -> Result<iroh::RelayUrl> {
    let url: iroh::RelayUrl = input
        .parse()
        .with_context(|| format!("'{input}' is not a valid relay url"))?;
    if !matches!(url.scheme(), "http" | "https") {
        anyhow::bail!(
            "'{input}' is not a valid relay url: a relay is reached over http or https, \
             and this names the scheme '{}'. A host, or a host and port, parses as a \
             scheme -- write it as https://{input}/ if that is what was meant.",
            url.scheme()
        );
    }
    Ok(url)
}

/// Resolve an endpoint id, plus an optional relay hint, into a dialable address.
///
/// Shared by both clients so "how do you address a peer" has one answer. An
/// empty `relay_url` means resolve by address lookup; supplying one skips that
/// round trip, which also makes a peer reachable before it has finished
/// publishing -- lookup routinely fails for a server that started seconds ago.
pub fn peer_addr(endpoint_id: &str, relay_url: &str) -> Result<iroh::EndpointAddr> {
    let mut addr = iroh::EndpointAddr::new(parse_endpoint_id(endpoint_id)?);
    let relay_url = relay_url.trim();
    if !relay_url.is_empty() {
        addr = addr.with_relay_url(parse_relay_url(relay_url)?);
    }
    Ok(addr)
}

/// Read a relay list into the relay mode an endpoint should bind with.
///
/// `spec` is what a user typed: relay URLs separated by commas or whitespace.
/// Empty means "leave the preset alone", which is n0's public relays -- the
/// default has to stay a default, so a blank setting cannot bind an endpoint
/// with no relays at all and no way to be reached.
///
/// Shared by both clients for the same reason `peer_addr` is: the DuckDB
/// setting and the browser's `relays` config are one string in one format, so
/// there is nothing to disagree about. This is the *local* endpoint's relay
/// map, which is where its home relay comes from and therefore what a minted
/// ticket carries. Reaching a peer through a relay is a separate thing that
/// needs no configuration at all -- iroh dials whatever relay URL the ticket
/// names, in or out of this map.
pub fn relay_mode(spec: &str) -> Result<Option<iroh::RelayMode>> {
    let urls = parse_relays(spec)?;
    if urls.is_empty() {
        return Ok(None);
    }
    Ok(Some(iroh::RelayMode::custom(urls)))
}

/// The relay list `spec` names, in the order a `RelayMap` would hold it.
///
/// Sorted and deduplicated, because that is what the map does with it: two
/// spellings of one list are one relay map, and a caller comparing lists is
/// asking about the map rather than about the typing.
fn parse_relays(spec: &str) -> Result<Vec<iroh::RelayUrl>> {
    let mut urls = spec
        .split(|c: char| c == ',' || c.is_whitespace())
        .filter(|url| !url.is_empty())
        .map(parse_relay_url)
        .collect::<Result<Vec<_>>>()?;
    urls.sort();
    urls.dedup();
    Ok(urls)
}

/// `spec` in a form two of them can be compared with `==`.
///
/// Exists for one caller: `quackhole_relays` is read when the endpoint binds,
/// so C++ has to be able to tell "you changed the setting after binding" from
/// "you said the same thing again with a space in it". Answering that by
/// comparing raw strings would make a reordered or re-spaced list -- the same
/// relay map -- look like a change, and answering it in C++ would be a second
/// parser of a format this file owns.
pub fn normalize_relays(spec: &str) -> Result<String> {
    Ok(parse_relays(spec)?
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(","))
}

/// Record or refresh a peer. Never overwrites a known path with "unknown".
pub(crate) fn record_peer(
    peers: &PeerMap,
    id: EndpointId,
    path: &'static str,
    direction: &'static str,
) {
    if let Ok(mut map) = peers.lock() {
        let entry = map.entry(id).or_insert(PeerEntry { path, direction });
        // Never downgrade a known path to "unknown", and keep the direction we
        // first saw: a peer we accepted stays "in" even if we later dial it.
        if path != "unknown" {
            entry.path = path;
        }
    }
}

#[cfg(not(target_family = "wasm"))]
impl Core {
    /// Bind an endpoint.
    ///
    /// `relays` is the relay list this endpoint homes on, in the format
    /// `relay_mode` reads; empty is n0's public relays. Parsed before the
    /// runtime is started so a typo in the setting is a bind-time error rather
    /// than an endpoint that came up on relays nobody asked for.
    pub fn new(key_path: Option<&Path>, ephemeral: bool, relays: &str) -> Result<Self> {
        let relay_mode = relay_mode(relays)?;

        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(worker_threads())
            .thread_name("quackhole")
            .enable_all()
            .build()
            .context("failed to start tokio runtime")?;

        let secret = match (key_path, ephemeral) {
            (Some(path), false) => load_or_create_key(path)?,
            _ => SecretKey::generate(),
        };

        let endpoint = runtime.block_on(async {
            let mut builder = Endpoint::builder(presets::N0)
                .secret_key(secret)
                .alpns(vec![ALPN.to_vec()]);
            // After the preset, not instead of it: N0 also configures address
            // lookup, and only the relay half of it is being replaced here.
            if let Some(mode) = relay_mode {
                builder = builder.relay_mode(mode);
            }
            builder.bind().await
        })?;

        let id = endpoint.id();
        Ok(Self {
            runtime: Some(runtime),
            endpoint_id_z32: id.to_z32(),
            endpoint_id_hex: id.to_string(),
            endpoint,
            serve: Mutex::new(None),
            conns: dial::ConnCache::default(),
            peers: PeerMap::default(),
            relays: Mutex::new(HashMap::new()),
        })
    }

    /// Snapshot of known peers, ordered by endpoint id so indexing is stable
    /// across the count/info calls the C++ side makes.
    pub fn peer_snapshot(&self) -> Vec<(EndpointId, PeerEntry)> {
        let Ok(map) = self.peers.lock() else {
            return Vec::new();
        };
        let mut peers: Vec<_> = map.iter().map(|(id, e)| (*id, e.clone())).collect();
        peers.sort_by(|(a, _), (b, _)| a.as_bytes().cmp(b.as_bytes()));
        peers
    }

    /// Remember the relay to reach one peer through.
    ///
    /// Set from a ticket, which carries the relay the peer actually published
    /// on. An empty `relay_url` forgets the peer rather than registering
    /// nothing, so re-attaching with a relay-less handoff does not silently
    /// keep dialling through a relay that peer has since left.
    pub fn set_peer_relay(&self, endpoint_id: &str, relay_url: &str) -> Result<()> {
        let id = parse_endpoint_id(endpoint_id)?;
        let relay_url = relay_url.trim();
        // Rejected here rather than at dial time: an unusable relay registered
        // now would surface as a failure on some later query, a long way from
        // the ATTACH that supplied it.
        if !relay_url.is_empty() {
            parse_relay_url(relay_url)?;
        }
        let mut relays = self
            .relays
            .lock()
            .map_err(|_| anyhow::anyhow!("quackhole relay map is poisoned"))?;
        if relay_url.is_empty() {
            relays.remove(&id);
        } else {
            relays.insert(id, relay_url.to_string());
        }
        Ok(())
    }

    /// The relay registered for `id`, or "" if none is.
    pub(crate) fn peer_relay(&self, id: &EndpointId) -> String {
        self.relays
            .lock()
            .ok()
            .and_then(|relays| relays.get(id).cloned())
            .unwrap_or_default()
    }

    pub fn endpoint_id_z32(&self) -> &str {
        &self.endpoint_id_z32
    }

    pub fn endpoint_id_hex(&self) -> &str {
        &self.endpoint_id_hex
    }

    fn runtime(&self) -> Result<&Runtime> {
        self.runtime
            .as_ref()
            .context("quackhole core has already been shut down")
    }

    /// Home relay URL, or "" if none is known yet.
    pub fn relay_url(&self) -> String {
        use iroh::Watcher;
        self.endpoint
            .home_relay_status()
            .get()
            .first()
            .map(|status| status.url().to_string())
            .unwrap_or_default()
    }

    /// Home relay URL, waiting up to `timeout` for one to be learned.
    ///
    /// An endpoint does not know its home relay the instant it binds -- it is
    /// learned a moment later. A ticket minted before then carries no relay, so
    /// the peer falls back to resolving through pkarr: a round trip to a third
    /// party that must also have seen this endpoint publish, which a server
    /// started seconds ago routinely has not. Native callers can retry; a
    /// browser handed a bad link cannot. Waiting here is what lets
    /// `quackhole_serve` return a link that works on the first click.
    ///
    /// Returns "" if the timeout expires, which callers must treat as "no
    /// ticket" rather than minting one with an empty relay.
    pub fn wait_relay_url(&self, timeout: Duration) -> String {
        let url = self.relay_url();
        if !url.is_empty() {
            return url;
        }
        let Ok(runtime) = self.runtime() else {
            return String::new();
        };
        runtime.block_on(async {
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                let url = self.relay_url();
                if !url.is_empty() {
                    return url;
                }
                if tokio::time::Instant::now() >= deadline {
                    return String::new();
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
    }

    /// Drop the runtime within `deadline`.
    ///
    /// Spends only the remaining budget on `shutdown_timeout`, so total teardown
    /// stays bounded by `deadline` rather than a multiple of it.
    pub fn shutdown(&mut self, deadline: Duration) {
        let start = std::time::Instant::now();
        if let Some(runtime) = self.runtime.take() {
            // Endpoint::close is async: it tells peers we are going away. Awaiting
            // it inside the still-live runtime is what makes shutdown graceful
            // rather than a socket that just stops answering.
            let endpoint = self.endpoint.clone();
            runtime.block_on(async move {
                let _ = tokio::time::timeout(deadline, endpoint.close()).await;
            });
            let remaining = deadline
                .saturating_sub(start.elapsed())
                .max(Duration::from_millis(1));
            runtime.shutdown_timeout(remaining);
        }
    }
}

#[cfg(not(target_family = "wasm"))]
fn worker_threads() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(2)
        .clamp(1, 4)
}

#[cfg(not(target_family = "wasm"))]
/// Read the endpoint key from `path`, creating it (mode 0600) if absent.
///
/// The key *is* the address, so persisting it is what lets `quack:<id>.iroh`
/// survive a restart. Stored as hex text so it can be inspected and copied.
fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    if path.exists() {
        return load_key(path);
    }

    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("failed to create key directory {}", dir.display()))?;
    }
    let secret = SecretKey::generate();
    // create_new + mode(0o600) in one call. Writing then chmod-ing leaves a window
    // where the private key is world-readable, and a plain create lets two
    // processes racing the exists() check above clobber each other's identity.
    // If we lose that race, fall through and read the winner's key.
    match create_private(path) {
        Ok(mut file) => {
            use std::io::Write;
            file.write_all(hex::encode(secret.to_bytes()).as_bytes())
                .with_context(|| format!("failed to write endpoint key at {}", path.display()))?;
            Ok(secret)
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => load_key(path),
        Err(e) => Err(anyhow::Error::new(e))
            .with_context(|| format!("failed to create endpoint key at {}", path.display())),
    }
}

#[cfg(not(target_family = "wasm"))]
/// Read and decode an existing key file.
fn load_key(path: &Path) -> Result<SecretKey> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("failed to read endpoint key at {}", path.display()))?;
    let raw = hex::decode(text.trim())
        .with_context(|| format!("endpoint key at {} is not hex", path.display()))?;
    let bytes: [u8; 32] = raw
        .as_slice()
        .try_into()
        .with_context(|| format!("endpoint key at {} is not 32 bytes", path.display()))?;
    Ok(SecretKey::from_bytes(&bytes))
}

#[cfg(not(target_family = "wasm"))]
#[cfg(unix)]
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
}

#[cfg(not(target_family = "wasm"))]
#[cfg(not(unix))]
fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
}

#[cfg(not(target_family = "wasm"))]
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A throwaway directory that cleans itself up.
    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "quackhole-test-{tag}-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn key_is_created_private_and_is_stable() {
        let dir = temp_dir("key");
        let path = dir.join("nested").join("key");

        // Creates the parent directory as well as the key.
        let first = load_or_create_key(&path).expect("create");
        assert!(path.exists());

        // The key IS the address, so a second load must return the same bytes --
        // otherwise an endpoint id would not survive a restart.
        let second = load_or_create_key(&path).expect("reload");
        assert_eq!(first.to_bytes(), second.to_bytes());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn key_is_never_world_readable() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("perm");
        let path = dir.join("key");
        load_or_create_key(&path).expect("create");

        // 0600 must come from the create call itself. Writing first and chmod-ing
        // after leaves a window where the private key is world-readable.
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "key mode was {mode:o}");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_key_file_is_an_error_not_a_new_identity() {
        let dir = temp_dir("corrupt");
        let path = dir.join("key");
        std::fs::write(&path, "not hex at all").unwrap();

        // Silently generating a fresh key here would change the endpoint id --
        // the address -- without telling anyone.
        assert!(load_or_create_key(&path).is_err());

        std::fs::write(&path, hex::encode([0u8; 16])).unwrap();
        assert!(load_or_create_key(&path).is_err(), "16 bytes is not a key");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn endpoint_ids_parse_in_every_form_iroh_prints() {
        let secret = SecretKey::generate();
        let id = secret.public();

        // Display is hex; to_z32 is a different alphabet with its own parser.
        // Accepting only FromStr would reject our own printed output.
        assert_eq!(parse_endpoint_id(&id.to_string()).unwrap(), id);
        assert_eq!(parse_endpoint_id(&id.to_z32()).unwrap(), id);
        assert_eq!(
            parse_endpoint_id(&format!("  {}  ", id.to_z32())).unwrap(),
            id
        );
        assert_eq!(id.to_z32().len(), 52, "z-base-32 must fit a DNS label");

        assert!(parse_endpoint_id("not-an-endpoint-id").is_err());
        assert!(parse_endpoint_id("").is_err());
    }

    #[test]
    fn a_relay_list_is_read_the_same_way_wherever_it_was_typed() {
        // Nothing said means the preset's relays, which is n0's. Binding an
        // endpoint with no relays because a setting was left blank would leave
        // it unreachable and say nothing about why.
        assert!(relay_mode("").unwrap().is_none());
        assert!(relay_mode("   ").unwrap().is_none());

        // A DuckDB setting is one string, so several relays are separated in
        // the string. Commas are what a person types; whitespace is what
        // survives copying a list out of a config file.
        let two = relay_mode("https://relay-a.example./, https://relay-b.example./")
            .unwrap()
            .expect("two relays");
        assert_eq!(two.relay_map().len(), 2);
        assert_eq!(
            relay_mode("https://relay-a.example./\nhttps://relay-b.example./")
                .unwrap()
                .expect("two relays")
                .relay_map()
                .len(),
            2
        );

        // Refused here, where the message can name the URL. Left to the
        // endpoint builder it would surface as a bind failure a long way from
        // the setting that caused it.
        let err = format!("{:#}", relay_mode("not a relay").unwrap_err());
        assert!(err.contains("not a valid relay url"), "{err}");
    }

    #[test]
    fn a_relay_url_that_cannot_be_dialled_is_not_a_valid_one() {
        // `Url::parse` accepts both of these: it reads the host as the scheme
        // and the port as the path. Accepting them binds an endpoint on a relay
        // map that can never connect, and the only symptom is a home relay that
        // never arrives.
        for input in ["relay.example.org:443", "localhost:8080"] {
            let err = format!("{:#}", parse_relay_url(input).unwrap_err());
            assert!(err.contains("http or https"), "{input}: {err}");
            // The message has to carry the fix, because the input looks right.
            assert!(err.contains("https://"), "{input}: {err}");
        }

        // A scheme iroh does not speak, and a bare host, which does not parse
        // as a URL at all.
        assert!(parse_relay_url("ftp://relay.example./").is_err());
        assert!(parse_relay_url("relay.example.org").is_err());
        // http and https are special schemes, so the URL parser has already
        // refused the host-less forms by the time the scheme is looked at.
        assert!(parse_relay_url("https://").is_err());
        assert!(parse_relay_url("http://:3340/").is_err());

        assert!(parse_relay_url("https://relay.example./").is_ok());
        assert!(parse_relay_url("http://127.0.0.1:3340/").is_ok());
    }

    #[test]
    fn two_spellings_of_one_relay_map_normalize_alike() {
        // What the C++ side compares to decide whether `quackhole_relays`
        // changed after the endpoint bound. A reordered or re-spaced list is
        // the same relay map, so it must not read as a change.
        let canonical = normalize_relays("https://a.example./,https://b.example./").unwrap();
        for spelling in [
            "https://b.example./, https://a.example./",
            "  https://a.example./\thttps://b.example./  ",
            "https://a.example./,https://b.example./,https://a.example./",
        ] {
            assert_eq!(normalize_relays(spelling).unwrap(), canonical, "{spelling}");
        }

        // And a list that is genuinely different still reads as different.
        assert_ne!(normalize_relays("https://a.example./").unwrap(), canonical);
        assert_eq!(normalize_relays("  ").unwrap(), "");
        assert!(normalize_relays("relay.example.org:443").is_err());
    }
}
