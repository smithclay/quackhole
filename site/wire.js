// The wire: browser -- relay -- laptop, drawn as it actually is.
//
// This is the page's thesis rendered as a diagram. It opens broken, because
// that is the true state of things when you arrive: there is no route between
// this tab and your laptop. Every step on the page closes a bit more of it.
//
// One of these per remote. Each is reached over its own relay, so a single
// diagram covering several would have to pick one relay to name.
//
// The shapes carry meaning without relying on colour: circle and square are
// the two DuckDBs (yellow, because that is where your data is), the diamond
// between them is a relay you do not run (periwinkle, the iroh half). A
// browser can only ever go through that diamond -- iroh compiles its IP
// transport out entirely under cfg(wasm_browser), so there is no direct path
// to draw even when one machine could offer it.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs) => {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

// Geometry in viewBox units. The relay sits dead centre so the two halves read
// as equal legs -- which they are, latency-wise.
const X = { browser: 60, relay: 300, laptop: 540 };
const Y = 42;

export function createWire(mount, peer = 'your laptop') {
  const svg = el('svg', { class: 'wire', viewBox: '0 0 600 84', role: 'img' });
  // Named, so several of these do not all announce themselves identically.
  svg.setAttribute('aria-label', `Connection from this browser through a relay to ${peer}`);

  // Two independent legs rather than one line: the left one lights up as soon
  // as the browser has an endpoint, the right only once the peer answers, so a
  // half-open connection looks half-open instead of merely "not green yet".
  // Inset from the node centres by more than the largest node radius, so the
  // dash pattern does not render inside the glyphs it connects.
  const GAP = 16;
  const legs = {
    left: el('path', { class: 'wire-leg', d: `M ${X.browser + GAP} ${Y} H ${X.relay - GAP}` }),
    right: el('path', { class: 'wire-leg', d: `M ${X.relay + GAP} ${Y} H ${X.laptop - GAP}` }),
  };
  svg.append(legs.left, legs.right);

  const pulse = el('circle', { class: 'wire-pulse', cx: X.browser, cy: Y, r: 5 });
  svg.append(pulse);

  // Named rather than positional. Selecting these by :first-of-type /
  // :last-of-type looks tidier and is wrong: the pulse above is also a
  // <circle>, so it claims :first-of-type and the browser node never matches.
  const nodes = {
    browser: el('circle', { class: 'wire-node wire-node--browser', cx: X.browser, cy: Y, r: 11 }),
    relay: el('rect', {
      class: 'wire-node wire-node--relay',
      x: X.relay - 9, y: Y - 9, width: 18, height: 18,
      transform: `rotate(45 ${X.relay} ${Y})`,
    }),
    laptop: el('rect', {
      class: 'wire-node wire-node--laptop',
      x: X.laptop - 10, y: Y - 10, width: 20, height: 20, rx: 2,
    }),
  };
  svg.append(nodes.browser, nodes.relay, nodes.laptop);

  mount.replaceChildren(svg);

  // The legend is a *sibling* of the mount, not a child -- replaceChildren
  // above owns everything inside `mount` -- so resolve the label from the
  // frame that contains both. Querying within `mount` silently finds nothing.
  const relayHost = mount.closest('.wire-frame')?.querySelector('.wire-relay-host');

  let pulseAnim = null;

  return {
    // 'idle' | 'browser' | 'laptop' | 'connecting' | 'live' | 'failed'
    setState(state) {
      svg.dataset.state = state;
    },
    setRelayLabel(url) {
      if (!relayHost) return;
      try {
        relayHost.textContent = new URL(url).host;
      } catch {
        relayHost.textContent = url;
      }
    },
    // One round trip, timed to the real measurement. The duration is clamped
    // into a visible band -- a 6ms answer is not perceivable -- so the readout
    // beside it, not the animation, is what states the number.
    pulse(ms) {
      pulseAnim?.cancel();
      const duration = Math.min(Math.max(ms, 340), 2200);
      pulseAnim = pulse.animate(
        [
          { transform: 'translateX(0)', opacity: 0 },
          { transform: 'translateX(0)', opacity: 1, offset: 0.06 },
          { transform: `translateX(${X.laptop - X.browser}px)`, opacity: 1, offset: 0.48 },
          { transform: `translateX(${X.laptop - X.browser}px)`, opacity: 1, offset: 0.52 },
          { transform: 'translateX(0)', opacity: 1, offset: 0.94 },
          { transform: 'translateX(0)', opacity: 0 },
        ],
        { duration, easing: 'cubic-bezier(.4,0,.6,1)' },
      );
    },
  };
}
