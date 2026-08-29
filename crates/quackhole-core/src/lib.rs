//! Transport core for the `quackhole` DuckDB extension.
//!
//! This crate moves opaque bytes between DuckDB processes over iroh QUIC streams.
//! It deliberately knows nothing about HTTP: the C++ side of the extension builds
//! request bytes and parses response bytes, so there is exactly one HTTP
//! implementation and this FFI surface stays small.

mod dial;
// Native-only: the C ABI exists for DuckDB, and a browser cannot serve --
// quack_serve itself throws NotImplementedException on wasm.
#[cfg(not(target_family = "wasm"))]
mod ffi;
#[cfg(not(target_family = "wasm"))]
mod serve;

pub use dial::{request_async, ConnCache};

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
pub struct Core {
    /// `Option` so `shutdown()` can take and time-bound the runtime teardown.
    runtime: Option<Runtime>,
    endpoint: Endpoint,
    endpoint_id_z32: String,
    endpoint_id_hex: String,
    serve: Mutex<Option<serve::ServeHandle>>,
    conns: dial::ConnCache,
    peers: PeerMap,
}

/// What `quackhole_status()` knows about one peer.
#[derive(Clone)]
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

/// Record or refresh a peer. Never overwrites a known path with "unknown".
pub(crate) fn record_peer(peers: &PeerMap, id: EndpointId, path: &'static str, direction: &'static str) {
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
    pub fn new(key_path: Option<&Path>, ephemeral: bool) -> Result<Self> {
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
            Endpoint::builder(presets::N0)
                .secret_key(secret)
                .alpns(vec![ALPN.to_vec()])
                .bind()
                .await
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
    std::fs::OpenOptions::new().write(true).create_new(true).open(path)
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
        assert_eq!(parse_endpoint_id(&format!("  {}  ", id.to_z32())).unwrap(), id);
        assert_eq!(id.to_z32().len(), 52, "z-base-32 must fit a DNS label");

        assert!(parse_endpoint_id("not-an-endpoint-id").is_err());
        assert!(parse_endpoint_id("").is_err());
    }
}
