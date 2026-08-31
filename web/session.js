// A DuckDB-Wasm session with remote DuckDBs attached into it over iroh.
//
// `shim.js` and `bridge-worker.js` carry bytes. This is the layer above them:
// what it takes to hold several remotes at once and keep a truthful list of
// them. Attaching is four statements that have to agree with each other, the
// relay has to be registered before the dial, names have to be unique, and the
// list has to survive a `DETACH` typed by hand into a query box.
//
// It lives here rather than in the app because none of that is app-specific,
// and because a demo that reimplemented it would stop being evidence that the
// shipped client works. `site/app.js` is a view over this and nothing more.
//
// What is deliberately NOT here: booting DuckDB-Wasm. Bundle selection, the
// logger and where the .wasm files are served from are the app's business, and
// a session that chose them for you would be harder to vendor, not easier.

import { parseTicket } from './peer.js';

/// Quote a string as a SQL literal.
const sqlString = (s) => `'${String(s).replaceAll("'", "''")}'`;

/// The first column of every row, as plain JS values.
///
/// Enough for the two metadata queries below. Result formatting -- BigInt,
/// timestamps, how many rows to show -- is a display decision and stays with
/// whoever is displaying.
const column = (table, name) => table.toArray().map((row) => row.toJSON()[name]);

export class QuackholeSession {
  /// `conn` is a duckdb-wasm AsyncDuckDBConnection; `worker` is the Worker it
  /// runs in, started from `qh-worker.js` so the shim is on the path. The
  /// worker is needed because registering a peer's relay travels through it.
  constructor({ conn, worker, localName = 'memory' }) {
    this.conn = conn;
    this.worker = worker;
    // The local wasm database is a connection like any other. Listing it first
    // is what makes attaching a remote read as adding a second one rather than
    // as the session's real beginning.
    this.connections = [{ name: localName, kind: 'local' }];
  }

  /// Run one statement. Everything the caller types goes through here.
  query(sql) {
    return this.conn.query(sql);
  }

  /// The catalog name a remote gets attached as.
  ///
  /// Auto-uniquified rather than demanded, because a ticket carries no name and
  /// refusing to connect until one is supplied is a worse first minute than a
  /// second remote called `remote2`. It is a DuckDB identifier and it is
  /// interpolated unquoted into SQL below, so nothing but this may produce one.
  #uniqueName(base) {
    const taken = new Set(this.connections.map((c) => c.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base}${n}`)) return `${base}${n}`;
  }

  /// Tell the transport which relay reaches a peer.
  ///
  /// Sent at the DuckDB worker, where the shim picks it off and forwards it to
  /// the bridge -- the same channel the ATTACH takes, so no acknowledgement is
  /// needed. Two messages on one port arrive in the order they were sent.
  #registerPeer(peer) {
    this.worker.postMessage({ __qh: 'peer', endpointId: peer.endpointId, relay: peer.relayUrl });
  }

  /// Attach the remote a ticket names.
  ///
  /// Resolves with the connection record. Throws with a message written for
  /// whoever pasted the ticket -- from `peer.js` if the ticket is the problem,
  /// from DuckDB if the attach is.
  ///
  /// `onDialing` is called once with the record, after the name is settled and
  /// before the dial. A dial over a relay takes a noticeable second, and a
  /// caller that wants to show it happening cannot wait for this to resolve to
  /// find out what to draw.
  async attach(ticket, { name = 'remote', onDialing } = {}) {
    const peer = await parseTicket(ticket);

    // Attaching the same peer twice would work and would be a lie: two
    // catalog names over one connection, listed as if they were two machines.
    const already = this.connections.find((c) => c.endpointId === peer.endpointId);
    if (already) throw new Error(`That DuckDB is already attached, as "${already.name}".`);

    const record = {
      name: this.#uniqueName(name),
      kind: 'remote',
      endpointId: peer.endpointId,
      relayUrl: peer.relayUrl,
      // Named after the peer, not after the catalog: that is the name the
      // extension's own quackhole_attach uses, so both spell one thing once.
      secretName: peer.secretName,
    };

    onDialing?.(record);

    // Before the ATTACH, and on the path the ATTACH takes, so the dial cannot
    // be made before the bridge knows which relay reaches this peer.
    this.#registerPeer(peer);

    try {
      // Named and scoped to this one endpoint. An unnamed secret is a single
      // global, so a second remote would either collide on the name or quietly
      // be handed the first one's token. Quack resolves the secret by the
      // ATTACH path, so the scope is what routes the right token to the right
      // peer -- and both strings come off the peer, which is what makes them
      // the same string. A scope that disagrees by one character fails as
      // "Could not find a Quack authentication token".
      if (peer.token) {
        await this.conn.query(
          `CREATE SECRET ${record.secretName} (TYPE quack, TOKEN ${sqlString(peer.token)},` +
            ` SCOPE ${sqlString(peer.address)})`,
        );
      }
      const t0 = performance.now();
      await this.conn.query(`ATTACH ${sqlString(peer.address)} AS ${record.name}`);
      record.attachMs = performance.now() - t0;
    } catch (err) {
      // Take the secret back out, so a retry is not refused by the leftovers of
      // the attempt that failed.
      await this.conn.query(`DROP SECRET IF EXISTS ${record.secretName}`).catch(() => {});
      throw err;
    }

    this.connections.push(record);
    return record;
  }

  /// Detach a remote and give its name back.
  ///
  /// The secret goes with it, so re-attaching the same peer later works --
  /// otherwise its `CREATE SECRET` collides with the one left behind.
  ///
  /// The list is not edited here: `reconcile` does that, against
  /// `duckdb_databases()`, which is the same path a hand-typed DETACH takes.
  /// Two ways to remove a connection would be two things to keep agreeing.
  async detach(record) {
    // If the DETACH fails, the catalog really is still attached and the list
    // should keep saying so, which is better feedback than an exception nobody
    // sees.
    await this.conn.query(`DETACH ${record.name}`).catch(() => {});
    await this.conn.query(`DROP SECRET IF EXISTS ${record.secretName}`).catch(() => {});
    return this.reconcile();
  }

  /// Drop remotes that are no longer attached, and say which went.
  ///
  /// The list is a claim about what this session holds, and anyone can type
  /// `DETACH remote2` into a query box and make it false. `duckdb_databases()`
  /// is the only thing that knows -- and it is the exception to the rule that a
  /// Quack catalog enumerates nothing: it answers locally, with no round trip,
  /// so reconciling against it costs nothing.
  async reconcile() {
    let live;
    try {
      live = new Set(column(await this.conn.query('SELECT database_name FROM duckdb_databases()'), 'database_name'));
    } catch {
      // Cannot tell, so claim nothing changed rather than emptying the list.
      return [];
    }
    const gone = this.connections.filter((c) => c.kind === 'remote' && !live.has(c.name));
    for (const record of gone) this.connections.splice(this.connections.indexOf(record), 1);
    return gone;
  }

  /// Every connection's tables, keyed by catalog name.
  ///
  /// Local and remote need different queries. A Quack-attached catalog is lazy:
  /// it resolves a table name on demand but enumerates nothing, so
  /// `duckdb_tables()`, `SHOW TABLES FROM remote` and `information_schema` are
  /// all empty for it. `sqlite_master` is the one listing Quack pushes down to
  /// the remote, which answers it from its own catalog.
  ///
  /// Reconciles first, so a catalog that has gone away is not asked about.
  /// A connection whose listing fails maps to an empty array rather than
  /// failing the whole call -- one unreachable remote must not blank the rest.
  async tables() {
    await this.reconcile();
    const listings = await Promise.all(
      this.connections.map(async (c) => {
        const sql =
          c.kind === 'local'
            ? 'SELECT table_name AS name FROM duckdb_tables() ORDER BY name'
            : `SELECT name FROM ${c.name}.sqlite_master ORDER BY name`;
        try {
          return [c.name, column(await this.conn.query(sql), 'name')];
        } catch {
          return [c.name, []];
        }
      }),
    );
    return new Map(listings);
  }
}
