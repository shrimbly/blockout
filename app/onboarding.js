// First-run help that gets out of the way: a start card while the scene is empty, framing the agent's
// first build, and one-time hints (each shown once per browser, closed with "Got it").

import { h, button } from './ui/kit.js';
import { store } from './store.js';

const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const SELECT_CLICK = MAC ? '⌘-click' : 'Ctrl-click';

const STARTERS = [
  'A rainy street with a woman at a bus stop, slow push-in over 5 seconds',
  'Low orbit around a car in an empty car park at dusk',
  'Two people talking at a cafe table, over-the-shoulder, then a cut to the reverse',
];

// ---------- one-time hints ----------
const seen = (id) => { try { return localStorage.getItem(`cc-hint-${id}`) === '1'; } catch { return false; } };
const markSeen = (id) => { try { localStorage.setItem(`cc-hint-${id}`, '1'); } catch {} };

let hintEl = null, hintId = null;
/** Show hint `id` unless it was seen before. actions: [{ label, onClick }] shown before "Got it". */
export function hint(id, text, { actions = [] } = {}) {
  if (seen(id) || hintId === id) return;
  closeHint();
  hintId = id;
  const close = () => { markSeen(id); closeHint(); };
  hintEl = h('div.cc-panel.hint', { role: 'status', 'data-hint': id },
    h('span.hint-text', {}, ...text),
    ...actions.map((a) => button({ label: a.label, kind: 'default', onClick: () => { close(); a.onClick(); } })),
    button({ label: 'Got it', kind: 'primary', onClick: close }));
  document.body.append(hintEl);
}
function closeHint() { hintEl?.remove(); hintEl = null; hintId = null; }

export function mountOnboarding({ viewport, prompt }) {
  // ---------- start card: only while the scene has no objects ----------
  const dot = h('span.cc-dot');
  const status = h('span');
  const card = h('div.cc-panel.start-card', { hidden: true },
    h('div.start-title', {}, 'Start your blockout'),
    h('p.start-text', {}, 'Describe a scene and a camera move in the chat. Your agent builds the set and keys the camera; you reframe and retime it here.'),
    h('div.start-label', {}, 'Try'),
    h('div.chat-starters', {}, ...STARTERS.map((text) => h('button.chat-starter', { type: 'button', onClick: () => prompt.fill(text) }, text))),
    h('div.start-foot', {}, h('span.start-status', {}, dot, status), h('span.start-drop', {}, 'or drop a .glb model here')));
  document.body.append(card);

  function refreshCard() {
    const empty = !!store.doc && store.doc.objects.length === 0;
    card.hidden = !empty;
    if (!empty) return;
    const { agent, working, listen } = store.state;
    const st = agent || listen ? 'listening' : working ? 'working' : 'off';
    dot.className = `cc-dot${st === 'listening' ? ' cc-dot--ok' : st === 'working' ? ' cc-dot--warn' : ''}`;
    status.textContent = st === 'listening' ? 'Your agent is listening' : st === 'working' ? 'Your agent is busy' : 'Your agent is not listening yet: see the chat';
  }

  // ---------- the agent's first build: frame it, then show what to do next ----------
  let count = null;
  store.on('doc', (doc) => {
    const n = doc.objects.length;
    const first = count === 0 && n > 0;
    count = n;
    refreshCard();
    if (!first || store.lastSource === 'ui' || store.lastSource === 'undo') return;
    // agents often build in several calls: wait for the rest of the build, then frame all of it
    setTimeout(() => {
      if (!store.doc?.objects.length) return;
      if (store.state.view === 'free') viewport.frame(null, { margin: 1.5 }); // looser than F: the floating UI covers the edges
      hint('first-build', [`Click anywhere to aim the camera there. ${SELECT_CLICK} an object to select and move it.`], {
        actions: [{ label: 'View shot', onClick: () => store.set({ view: 'shot' }) }],
      });
    }, 900);
  });
  store.on('state', (c) => {
    if (c.agent || c.working || c.listen) refreshCard();
    if (c.view && store.state.view === 'shot' && store.doc?.objects.length) {
      hint('shot-view', ['You are looking through the shot camera. Drag to reframe, then press ', h('span.cc-kbd', {}, 'K'), ' to key it at the playhead. ', h('span.cc-kbd', {}, 'C'), ' goes back to Free view.']);
    }
  });
  // a plain click on an object aims at it; people new to the canvas usually meant to select it
  store.on('aimed', ({ object }) => {
    if (object && hintId !== 'first-build') hint('click-aims', [`That click aimed the camera. To select the object, ${SELECT_CLICK} it.`]);
  });
}
