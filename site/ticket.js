// A ticket is the one string a user carries from their laptop to this page.
//
// It exists because `attach_sql` -- the paste-ready string quackhole_serve
// already prints -- carries the endpoint id and the token but NOT the relay
// URL, and a browser needs all three. Without the relay, iroh has to resolve
// the peer through pkarr over HTTPS, which is a round trip to a third party
// that must also have seen the peer publish; a server that started seconds ago
// routinely has not, and the dial fails with "All address lookup services
// failed". Native clients get away with omitting it because they can retry
// later. A person watching a demo page will not.
//
// The format is `qh1_` + base64url(JSON), for two reasons. It is one token with
// no spaces, so it survives a copy out of a terminal and a paste into an input
// without a half-selection silently truncating it. And the `qh1_` prefix means
// a future field can change the version rather than being guessed at.
//
// The laptop side mints these -- see scripts/quackhole-demo.sh and the manual
// SQL on the page -- so any change here has to change there too.

// Decode only. Nothing in the browser mints a ticket -- the two encoders live
// on the laptop, in shell and in SQL -- and a third one here would be a fourth
// implementation of the format for no caller to use.
const PREFIX = 'qh1_';

const b64urlDecode = (str) => {
  // atob wants standard alphabet and padding back.
  const padded = str.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(str.length / 4) * 4, '=');
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)));
};

// Throws with a message written for the person holding the ticket, because
// every one of these lands directly in the page's error slot.
export function decodeTicket(input) {
  const raw = (input ?? '').trim();
  if (!raw) throw new Error('Paste the ticket your laptop printed.');

  // Be generous about what arrives: people copy the surrounding quotes, the
  // shell prompt, or the whole line. Pull out the first thing shaped like a
  // ticket rather than rejecting the paste.
  const found = raw.match(/qh1_[A-Za-z0-9_-]+/);
  if (!found) {
    throw new Error(
      raw.length < 60 && !raw.includes(' ')
        ? 'That looks like an endpoint id, not a ticket. The ticket starts with qh1_ and also carries the relay and token.'
        : 'No ticket in that text. Look for the string starting with qh1_.',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(b64urlDecode(found[0].slice(PREFIX.length)));
  } catch {
    throw new Error('That ticket is damaged — it decodes to nothing. Copy the whole qh1_ string and try again.');
  }

  const { e: endpointId, r: relayUrl, t: token } = parsed;
  if (!endpointId) throw new Error('That ticket has no endpoint id in it.');
  // A ticket minted before the endpoint learned its home relay is the one
  // failure that looks fine and then hangs, so refuse it by name.
  if (!relayUrl) {
    throw new Error('That ticket was minted before the endpoint knew its relay. Re-run the ticket line on your laptop.');
  }
  return { endpointId, relayUrl, token: token ?? '' };
}
