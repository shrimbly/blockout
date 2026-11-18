// Shots: one set, several cameras. The key track always stacks the shots (one row per shot on the shared
// action-time axis, drawn and edited by timeline.js: drag a bar sideways to change where it picks up the
// action, up or down to reorder, click it and press Delete to remove it), with a "+ New shot" row under them.
// Clicking that row (or Shift+N) adds the next shot, picking up where the active one ends; dragging across it
// draws any span (from 0 for coverage, from the playhead to carry on from there). A new shot starts on the
// active shot's framing at its first moment. [ and ] switch, Shift+[ and Shift+] move the active shot,
// "Play all" plays through the cuts, Shift-click Export renders the whole sequence. Everything goes through
// the shot.* ops, so the agent can do the same from the CLI.

import { button, toast } from './ui/kit.js';
import { store } from './store.js';

export function mountShots() {
  const op = (ops, lbl) => store.op(ops, lbl).catch(() => null);
  // Switching is not an undo step of its own: undo goes back to the last change (and the shot it was made on).
  const switchTo = (id) => store.op({ op: 'shot.use', id }, 'switch shot', { amend: true }).catch(() => null);
  const use = async (id) => {
    if (id === store.doc.shot) return;
    store.set({ playing: false, key: null });
    if (await switchTo(id)) store.set({ camDirty: false, time: 0 });
  };
  /** New shot after the active one, on its framing at the moment it starts. Default: the next shot, from where
   *  the active one ends and as long; { start, duration } for any other span of the action. If it starts
   *  inside the active shot, the confirmation offers to end that shot there so the action doesn't play twice. */
  const add = async ({ start, duration } = {}) => {
    store.set({ playing: false, key: null });
    const prev = store.doc.shots.find((s) => s.id === store.doc.shot), tl = store.doc.timeline;
    const p0 = tl.start || 0, pEnd = p0 + tl.duration, F = tl.fps;
    const o = { op: 'shot.add', frame: true };
    if (start != null) o.start = start;
    if (duration != null) o.duration = duration;
    const r = await op(o, 'new shot');
    if (!r) return;
    store.set({ camDirty: false, time: 0 });
    const { name, start: st } = r[0];
    const msg = `${name} starts at ${st.toFixed(2)} s on ${prev.name}'s framing. Frame it, then press K`;
    if (st > p0 + 1 / F - 1e-6 && st < pEnd - 1 / F + 1e-6) {
      toast(msg, { ms: 8000, action: { label: `End ${prev.name} at ${st.toFixed(2)} s`, onClick: () => {
        op({ op: 'timeline', duration: +(st - p0).toFixed(3), shot: prev.id }, `end ${prev.name}`)
          .then((x) => x && toast(`${prev.name} now ends at ${st.toFixed(2)} s, where ${name} starts`));
      } } });
    } else toast(msg);
  };
  /** Move the active shot earlier (-1) or later (+1) in the sequence. */
  const move = (d) => {
    const i = store.doc.shots.findIndex((s) => s.id === store.doc.shot);
    const to = i + 1 + d;
    if (to >= 1 && to <= store.doc.shots.length) op({ op: 'shot.move', to }, 'reorder shots');
  };

  const playAllBtn = button({ icon: 'layers', kind: 'ghost', title: 'Play all: playback runs on through the cuts into the next shot', onClick: () => store.set({ playAll: !store.state.playAll }) });

  /** Playback reached the end of the shot with Play all on: go on into the next one. Resolves true if it did. */
  async function playOn() {
    const s = store.doc.shots, i = s.findIndex((x) => x.id === store.doc.shot);
    const next = s[i + 1] ?? (store.state.loop ? s[0] : null);
    if (!next || next.id === store.doc.shot) return false;
    if (!(await switchTo(next.id))) return false;
    store.set({ time: 0, camDirty: false, key: null });
    return true;
  }

  function refresh() {
    if (!store.doc) return;
    playAllBtn.setActive(!!store.state.playAll);
    playAllBtn.style.display = store.doc.shots.length < 2 ? 'none' : ''; // .cc-btn sets display, so hidden would not hide it
  }

  return {
    playAllBtn, refresh, add, use, playOn, move,
    next: (d) => {
      const s = store.doc.shots, i = s.findIndex((x) => x.id === store.doc.shot);
      const j = Math.max(0, Math.min(s.length - 1, i + d));
      if (j !== i) use(s[j].id);
    },
  };
}
