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
// `run-sql` takes that further and returns no rows at all: it types the
// statement at the terminal, where the result is drawn for whoever is sitting
// in front of it. An agent querying somebody's machine over a connection of its
// own, invisibly, beside a terminal showing nothing, is the version of this
// page nobody should ship -- and the visible one costs an agent only the thing
// it can ask for. So what comes back is that the statement ran, not what it
// said.
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

/// A relay's host, or null for a peer whose ticket carried no relay.
///
/// `relayUrl` is a plain string off the ticket, and `peer.rs` has an explicit
/// empty case for an endpoint that had not learned its home relay yet -- so
/// `new URL(...)` here is a throw waiting on an unusual ticket. Unguarded inside
/// `list-connections` that would be one relay-less remote turning the whole
/// answer into `Invalid URL`, telling an agent nothing about any of the other
/// connections. `wire.js` guards the same call for the same reason.
const relayHost = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

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
export async function registerAgentTools({ session, attach, run, refresh, remedyFor }) {
  const ctx = modelContext();
  if (!ctx) return false;

  // Nothing cancels a statement once it is at the prompt. `execute` is handed an
  // AbortSignal, and there is nothing to hand it to: the statement was typed
  // into a terminal this page does not own, and the query under it is behind the
  // XHR shim with a thread parked in `Atomics.wait`. The spec drops the result
  // of a cancelled execution, so an agent that gives up is not left holding one;
  // the statement finishes and its rows land on screen either way. Worth knowing
  // before reading the signal as a timeout.
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
            relay: relayHost(conn.relayUrl),
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
          // The view's own refresh rather than `session.tables()` directly, even
          // though the tool wants only what it returns. `tables()` reconciles
          // against duckdb_databases() and drops remotes that have gone, so
          // calling it bare would answer correctly and leave the rail beside it
          // still listing a catalog the session no longer has -- which is the
          // one thing a list of connections must never do.
          const groups = await refresh();
          return {
            ok: true,
            connections: s.connections.map((c) => ({
              name: c.name,
              kind: c.kind,
              ...(c.kind === 'remote' && { endpointId: c.endpointId, relay: relayHost(c.relayUrl) }),
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
      title: 'Run SQL in the workbench terminal',
      description:
        "Type one SQL statement at the workbench's terminal and run it, exactly as the person sitting" +
        ' in front of it would. The result is drawn in their terminal rather than returned here: what' +
        ' comes back is whether the statement ran and how long it took, so ask the person what it said.' +
        ' Reach a remote table by qualifying it with the catalog name list-connections reports, as in' +
        ' "SELECT * FROM remote.events;". A statement that writes runs on the machine that owns the' +
        ' catalog and is delivered at most once -- if one fails, check whether it landed before' +
        ' sending it again.',
      inputSchema: {
        type: 'object',
        properties: {
          sql: {
            type: 'string',
            description:
              'One SQL statement ending in a semicolon, in printable ASCII. Newlines are collapsed' +
              ' to spaces, so -- comments cannot be used; use /* */ instead.',
          },
        },
        required: ['sql'],
        additionalProperties: false,
      },
      // Not read-only: this runs whatever it is given, including INSERT and
      // DDL, and on a remote that means on somebody else's machine. No rows
      // come back, but a failure's message does, and DuckDB quotes the offending
      // value into plenty of them -- so what returns from a remote is still
      // content this page did not write.
      annotations: { untrustedContentHint: true },
      execute: async ({ sql }) => {
        try {
          return { ok: true, elapsedMs: Math.round(await run(sql)) };
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
