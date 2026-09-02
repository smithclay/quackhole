// The workbench, offered to an agent running in the browser.
//
// WebMCP lets a page register tools an agent can call -- an MCP server whose
// tools are client-side script in the tab rather than an endpoint on a backend.
// https://webmachinelearning.github.io/webmcp/
//
// Three of them, which are the three things this page is: attach a remote
// DuckDB, say what is attached, run a statement. Each goes through
// `QuackholeSession` and then the view's own redraw, so a remote an agent
// attached leaves the rail, the routes and the terminal in the state a
// visitor's click would have left them in. There is deliberately no second way
// to attach in here -- that is the same trade the rest of this page makes.
//
// Registered from `site/` rather than from `web/`. `web/` is the connection
// model, copied verbatim into anything that vendors it, and a transport library
// that reached for its host page's `document` and hung tools on it would be
// deciding something that is not the transport's to decide. An agent surface is
// a view, and this file is part of the view.
//
// Nothing here is load-bearing. The API is behind
// chrome://flags/#enable-webmcp-testing or an origin trial token everywhere it
// exists at all, so the ordinary outcome is that no tool is registered and the
// page is exactly what it was.

/// Where the browser puts it, or null.
///
/// `document.modelContext` is where the spec moved it in the May 2026 draft;
/// Chrome's origin trial shipped `navigator.modelContext` first and preview
/// builds still answer to both. Reading `document` first means a build that has
/// both is used through the shape that is going to survive.
const modelContext = () => document.modelContext ?? navigator.modelContext ?? null;

/// How many rows a statement returns to an agent.
///
/// A cap rather than a page: an agent that wants a number should ask DuckDB for
/// the number, and one that wants the whole table has misunderstood what it is
/// holding. The full count comes back beside the rows either way, so a
/// truncated answer is never mistaken for a complete one.
const MAX_ROWS = 100;

/// A value the user agent can serialize.
///
/// Whatever `execute` resolves with is JSON-stringified before the agent sees
/// it, and `JSON.stringify` throws on a BigInt -- which is what DuckDB hands
/// back for BIGINT, HUGEINT and every `count(*)`. So the first statement anyone
/// runs is the one that breaks, and it breaks invisibly: the serialization step
/// happens after `execute` has resolved, and a failure there reaches the agent
/// as a tool call that failed with no reason attached.
///
/// Integers outside the double-safe range become decimal strings rather than
/// silently rounding, because a HUGEINT that came back off by four is worse
/// than one that came back quoted.
///
/// `toJSON` covers Arrow's own row and vector types, which is what a STRUCT or
/// a LIST column arrives as. It has to be reached *after* the typed-array case
/// rather than before it, because Arrow's wide-integer types are both: a
/// DECIMAL arrives as a view over its words, and its `toJSON` returns a string
/// that is already quoted -- Arrow's own convention, for splicing into JSON
/// text. Calling it would quote `45` a second time and hand the agent `"\"45\""`.
/// `toString` on the same object is the plain decimal. A view with no `toJSON`
/// is a BLOB, which is bytes.
function jsonSafe(v) {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Date) return v.toISOString();
  if (ArrayBuffer.isView(v)) return typeof v.toJSON === 'function' ? String(v) : [...v].map(jsonSafe);
  if (typeof v.toJSON === 'function') return jsonSafe(v.toJSON());
  if (Array.isArray(v)) return v.map(jsonSafe);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
}

/// The columns Arrow answers with a bare epoch offset, by name.
///
/// A DATE and a TIMESTAMP both come back as milliseconds since the epoch --
/// `1788220800000` where the query said `current_date`. The number is right and
/// nothing else about it is: an agent reading a result has no reason to guess
/// at a unit, and the column type sitting beside it is not an instruction it
/// should have to follow. The schema says which columns they are, so this reads
/// it rather than sniffing values -- a plain BIGINT is the same JavaScript
/// number and must stay one.
const epochColumns = (schema) =>
  schema.fields.filter((f) => /^(Date|Timestamp)/.test(String(f.type))).map((f) => f.name);

/// Report a failure to the agent as a value, not as a rejection.
///
/// A rejected `execute` promise loses everything it was rejected with: the spec
/// hands the user agent null and false, so the agent is told the call failed and
/// nothing about why. Every message worth reading -- a mistyped ticket, a
/// missing table, a token scoped to the wrong peer -- would go with it.
///
/// So failures come back as ordinary results with `ok: false`, and carry the
/// same remedy the page puts under an error on screen. `docs/TROUBLESHOOTING.md`
/// is keyed by these strings, and an agent that can read the remedy can fix the
/// thing without asking.
const failure = (err, remedyFor) => {
  const error = String(err?.message ?? err);
  const remedy = remedyFor(error);
  return remedy ? { ok: false, error, remedy } : { ok: false, error };
};

/// Register the workbench's tools, if this browser has anywhere to put them.
///
/// Everything is reached through the callbacks rather than captured, because
/// `.open` typed at the shell's prompt resets the database and `site/app.js`
/// builds a new `QuackholeSession` over what replaced it. A tool holding the
/// session it was registered with would go on querying a connection that no
/// longer exists, and the shell reports that as `Invalid connection id`.
///
/// Never throws. `registerTool` rejects on a duplicate name, on an invalid
/// schema, and with a `SecurityError` when the document is not in an
/// origin-keyed agent cluster -- and none of those are worth costing a visitor
/// a working page.
///
/// That last one is free here and would not be on an ordinary site: a page is
/// origin-keyed if it asks for it with `Origin-Agent-Cluster: ?1` *or* if it is
/// cross-origin isolated, which this page has to be anyway because the transport
/// parks a thread in `Atomics.wait` on a `SharedArrayBuffer`. The COOP/COEP pair
/// that buys the transport its memory buys the tools their agent cluster.
export async function registerAgentTools({ session, attach, afterQuery, remedyFor }) {
  const ctx = modelContext();
  if (!ctx) return false;

  // Nothing cancels a statement once it is on the wire. `execute` is handed an
  // AbortSignal, and a query already dialled through the relay has no way back
  // -- DuckDB-Wasm's connection is behind the XHR shim, and the shim is what
  // `Atomics.wait` is parked on. The spec drops the result of a cancelled
  // execution, so an agent that gives up is not left holding it; the statement
  // just finishes. Worth knowing before reading the signal as a timeout.
  const tools = [
    {
      name: 'attach-remote',
      title: 'Attach a remote DuckDB',
      description:
        'Attach a remote DuckDB to this workbench from a quackhole ticket -- the qh1_… word that' +
        ' quackhole_serve() prints on the machine holding the data. The ticket embeds an access token,' +
        ' so treat it as a password. Returns the catalog name the remote was attached under, which is' +
        ' what qualifies every later query against it.',
      inputSchema: {
        type: 'object',
        properties: {
          ticket: { type: 'string', description: 'The qh1_… ticket, one word with no spaces.' },
        },
        required: ['ticket'],
        additionalProperties: false,
      },
      execute: async ({ ticket }) => {
        try {
          const conn = await attach(String(ticket ?? '').trim());
          return {
            ok: true,
            name: conn.name,
            endpointId: conn.endpointId,
            relay: new URL(conn.relayUrl).host,
            attachedInMs: Math.round(conn.attachMs),
          };
        } catch (err) {
          return failure(err, remedyFor);
        }
      },
    },

    {
      name: 'list-connections',
      title: 'List connections',
      description:
        'List the DuckDB databases attached to this workbench and the tables each one holds. "memory"' +
        ' is the local database running in this browser tab; every other entry is a remote DuckDB' +
        ' reached over an iroh relay. Call this before run-sql to learn the catalog names that qualify' +
        ' a table.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      // Reads and nothing else, so an agent is free to call it whenever it has
      // lost track. Its tables come off machines this page does not control,
      // which is exactly what the second hint is for.
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => {
        const s = session();
        if (!s) return { ok: false, error: 'The workbench has no DuckDB session.' };
        try {
          // Reconciles against duckdb_databases() on the way, so a remote that
          // was detached by hand at the prompt is already gone from the answer.
          const groups = await s.tables();
          return {
            ok: true,
            connections: s.connections.map((c) => ({
              name: c.name,
              kind: c.kind,
              ...(c.kind === 'remote' && { endpointId: c.endpointId, relay: new URL(c.relayUrl).host }),
              tables: groups.get(c.name) ?? [],
            })),
          };
        } catch (err) {
          return failure(err, remedyFor);
        }
      },
    },

    {
      name: 'run-sql',
      title: 'Run SQL',
      description:
        'Run one SQL statement against this workbench and return the rows. Reach a remote table by' +
        ' qualifying it with the catalog name list-connections reports, as in' +
        ' "SELECT * FROM remote.events". Aggregate in SQL rather than fetching rows: only the first' +
        ` ${MAX_ROWS} are returned, and DuckDB is faster at counting than you are. A statement that` +
        ' writes runs on the machine that owns the catalog, and delivery is at most once -- if one' +
        ' fails with a transport error it may still have landed, so check before running it again.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'One SQL statement.' },
        },
        required: ['sql'],
        additionalProperties: false,
      },
      // Not read-only: this runs whatever it is given, including INSERT and
      // DDL, and on a remote that means on somebody else's machine. Rows come
      // back off that machine too.
      annotations: { untrustedContentHint: true },
      execute: async ({ sql }) => {
        const s = session();
        if (!s) return { ok: false, error: 'The workbench has no DuckDB session.' };
        const text = String(sql ?? '');
        try {
          const t0 = performance.now();
          const table = await s.query(text);
          const ms = performance.now() - t0;

          // The same hook the shell's own statements land on: it pulses the
          // route to whichever remote the SQL names and redraws the rail after
          // DDL. The session queries through a connection on the real database
          // rather than the observed proxy, so nothing calls this for us.
          afterQuery(text, ms);

          // Taken a row at a time rather than with toArray(), which would
          // materialise every row of a result this is about to throw away.
          const epochs = epochColumns(table.schema);
          const rows = [];
          for (const row of table) {
            if (rows.length >= MAX_ROWS) break;
            const o = jsonSafe(row.toJSON());
            for (const k of epochs) if (typeof o[k] === 'number') o[k] = new Date(o[k]).toISOString();
            rows.push(o);
          }

          return {
            ok: true,
            columns: table.schema.fields.map((f) => ({ name: f.name, type: String(f.type) })),
            rows,
            rowCount: table.numRows,
            truncated: table.numRows > rows.length,
            elapsedMs: Math.round(ms),
          };
        } catch (err) {
          return failure(err, remedyFor);
        }
      },
    },
  ];

  try {
    for (const tool of tools) await ctx.registerTool(tool);
  } catch (err) {
    // Loud in the console and nowhere else. Whoever turned the flag on is the
    // only person who can act on this, and they have a console open.
    console.error('[quackhole] could not register the WebMCP tools:', err);
    return false;
  }

  console.info(`[quackhole] ${tools.length} WebMCP tools registered: ${tools.map((t) => t.name).join(', ')}`);
  return true;
}
