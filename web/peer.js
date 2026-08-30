// Peer identity, read by the same Rust that writes it.
//
// A ticket, the `quack:<id>.iroh:9494` address, and the name of the secret that
// authenticates against it are all derived from one endpoint id, and all three
// used to be spelled out here in JavaScript as well as in the extension's C++.
// They are not obvious shapes -- which fields a ticket may omit, what a missing
// relay means, that ATTACH and the secret's SCOPE have to be character-for-
// character the same string -- so two implementations were two things to keep
// agreeing. This is the same trade `protocol.js` makes for the shared memory
// layout, one level up.
//
// The transport module is loaded on demand rather than at import. A page that
// never takes a ticket never pays for it, and by the time one arrives the
// bridge has usually pulled the same file into the HTTP cache already.

let pending = null;

/// The wasm transport module, initialised once per realm.
///
/// Both callers want the same instance: the bridge dials with it and this file
/// parses with it, and initialising twice would compile the module twice.
export function transport() {
  pending ??= (async () => {
    const module = await import('./wasm/quackhole.js');
    await module.default();
    return module;
  })();
  return pending;
}

/// Read a ticket into a `Peer`.
///
/// Throws with a message written for the person holding the ticket -- they are
/// the reader, whether it lands in a page's error slot or a DuckDB error.
export async function parseTicket(input) {
  const { Peer } = await transport();
  return Peer.parseTicket(input);
}
