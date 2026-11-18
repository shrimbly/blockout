// Camera timeline: transport, keyframe track, selected-key controls and the easing / speed curve editor.

import { h, button, segmented, number, select, icon, toast, affix, panel, toggle as onOff } from './ui/kit.js';
import { EASES, bezier, bezierSpeed, resolveEase, easeName, sampleCamera, fovToLens, lensToFov, isCut } from '/core/curves.js';
import { store } from './store.js';
import { mountAudioTrack } from './audiotrack.js';
import { mountShots } from './shots.js';
import { shotList } from '/core/doc.js';

const PAD = 14;
const SIZES = [[1280, 720], [1920, 1080], [3840, 2160], [1080, 1920], [1080, 1080], [1440, 1080]];
const RETIME_KEY = 'cc-retime';

/** Run fn only when key changed since the last call for this element. Refreshes run every frame while
 *  playing; rebuilding a button's children under the pointer swallows clicks, and rebuilding a select closes it. */
function changed(el, key, fn) { key = JSON.stringify(key); if (el._ccKey !== key) { el._ccKey = key; fn(); } }

/** A tiny inline SVG of an ease curve, for buttons. */
export function easeSvg(ease, size = 14) {
  const b = resolveEase(ease);
  let d = '';
  if (b === 'hold') d = 'M2 13H13V3';
  else for (let i = 0; i <= 16; i++) { const u = i / 16; d += `${i ? 'L' : 'M'}${(2 + u * 12).toFixed(2)} ${(13 - bezier(b, u) * 10).toFixed(2)}`; }
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
}
const fmtFps = (v) => String(+(+v).toFixed(3));

export function mountTimeline(root, { viewport, exporter }) {
  // ---------- bar: play | camera | output ----------
  const playBtn = button({ icon: 'play', title: 'Play / pause (Space)', onClick: () => store.set({ playing: !store.state.playing }) });
  const startBtn = button({ icon: 'start', title: 'Go to start (Home)', kind: 'ghost', onClick: () => seek(0) });
  const loopBtn = button({ icon: 'loop', title: 'Loop playback', kind: 'ghost', onClick: () => store.set({ loop: !store.state.loop }) });
  const timeNow = h('span');
  const timeDur = h('span.tl-faint');
  const frameEl = h('span.cc-mono.tl-faint.tl-frame', { title: 'Frame at the playhead' });
  const timeEl = h('span.cc-mono.tl-time', {}, timeNow, timeDur);
  const viewSeg = segmented({
    options: [{ value: 'free', label: 'Free', icon: 'orbit', title: 'Orbit the set (C)' }, { value: 'shot', label: 'Shot', icon: 'camera', title: 'Look through the timeline camera (C)' }],
    value: store.state.view, onChange: (v) => store.set({ view: v }),
  });
  const keyBtn = button({ icon: 'keyAdd', label: 'Key', title: 'Key the current view at the playhead (K)', onClick: () => keyFromView() });
  // Key the selected object where it is now, at the playhead. Once it has a key, dragging it with the
  // gizmo at another time adds the next key, so a move is: key, scrub, drag.
  const objKeyLabel = h('span');
  const objKeyBtn = h('button.cc-btn.tl-objkey', { type: 'button', onClick: () => keyObject() }, h('span.tl-odot'), objKeyLabel);

  // selected key: time, ease (opens the curve editor), lens, set to view, delete
  const keyTime = h('span.cc-mono.tl-keytime');
  const easeGlyph = h('span.tl-glyph');
  const easeName_ = h('span.tl-ease-name');
  const easeBtn = h('button.cc-field.tl-ease', { type: 'button', onClick: () => curve.toggle(undefined, 'segment') }, easeGlyph, easeName_, icon('chevronDown'));
  // Lens: sets the selected key's focal length and the free camera's, so the free view looks through the
  // same lens you are keying. With no key selected it sets just the free camera.
  const lensNum = number({ step: 1, min: 8, max: 300, precision: 0, title: 'Lens (mm, full-frame equivalent): the selected key and the free view', width: 34, onInput: (v) => viewport.setFreeFov(lensToFov(v)), onChange: (v) => {
    const fov = +lensToFov(v).toFixed(3);
    viewport.setFreeFov(fov);
    if (store.state.key) updateKey({ fov });
  } });
  const lensField = affix(lensNum, 'mm');
  // Roll (Dutch tilt): like Lens, the selected key's and the free view's. In shot view it hand-frames the
  // shot camera, so K keys it. Hold the right mouse button and press Z / X to roll by hand.
  // the view takes the roll unless a key drives the shot camera, which then follows the key
  const rollLive = () => store.state.view === 'free' || store.state.camDirty || !store.state.key;
  const rollNum = number({ step: 1, min: -180, max: 180, precision: 0, title: 'Roll (degrees): the selected key and the free view', width: 30,
    onInput: (v) => { if (rollLive()) viewport.setRoll(v); },
    onChange: (v) => {
      const live = rollLive();
      if (live) viewport.setRoll(v);
      if (store.state.key && (store.state.view === 'free' || !live)) updateKey({ roll: v });
    } });
  const rollField = affix(rollNum, '°');
  const toViewBtn = button({ icon: 'aim', title: 'Set this key to the current view', kind: 'ghost', onClick: () => { const p = viewport.getPose(); updateKey({ position: p.position, target: p.target, fov: p.fov, roll: p.roll }); } });
  const delKeyBtn = button({ icon: 'trash', title: 'Delete key', kind: 'ghost', onClick: () => deleteKey() });
  const keyGroup = h('div.tl-key', {}, h('span.tl-diamond'), keyTime, easeBtn, toViewBtn, delKeyBtn);

  // output: shot settings chip + export
  const shotDur = h('span'), shotFps = h('span');
  const shotBtn = h('button.cc-btn.tl-shot', { type: 'button', title: 'Shot length, frame rate and size', onClick: () => shot.toggle() },
    icon('frame'), h('span.tl-shot-name', {}, 'Shot'), h('span.cc-mono', {}, shotDur, h('span.cc-affix__unit', {}, ' s')), h('span.tl-faint.tl-shot-fps', {}, '·'), h('span.cc-mono.tl-shot-fps', {}, shotFps, h('span.cc-affix__unit', {}, ' fps')), icon('chevronDown'));
  const exportBtn = button({ icon: 'film', label: 'Export', kind: 'primary', title: 'Render the blockout video (mp4)',
    onClick: (e) => exporter.exportVideo({ sequence: e.shiftKey && store.doc.shots.length > 1 }).catch((err) => toast(err.message, { kind: 'error' })) });

  // audio: a waveform lane under the track, an Audio button in the bar (functions below are hoisted)
  const audioTrack = mountAudioTrack(root, {
    xOf: (t) => xOf(t), tOf: (x, free) => tOf(x, free), seek: (t) => seek(t),
    cutXs: () => cutsOf(liveKeys()).map((c) => c.x), keyXs: () => [...keyXs(liveKeys()).values()],
  });

  const shots = mountShots();
  const bar = h('div.tl-bar',
    {}, startBtn, playBtn, loopBtn, timeEl, frameEl, h('span.cc-divider'), viewSeg, keyBtn, lensField, rollField, keyGroup, objKeyBtn,
    h('span.cc-spacer'), shots.playAllBtn, audioTrack.btn, shotBtn, exportBtn);

  // When the controls don't fit, step the bar down (.is-fit1..3 in app.css) only as far as it needs: one level
  // up while it overflows, and one level back whenever it would fit again. At the last level (4) the less used
  // controls move into a ⋯ menu, as they are, so they keep working and show their labels there. Runs on resize
  // and when the bar's contents change (a key selected, an object keyed, audio loaded), at most once a frame.
  const moreBtn = button({ icon: 'more', kind: 'ghost', title: 'More: loop, play all, audio, shot settings, object key', onClick: () => toggleMore() });
  moreBtn.classList.add('tl-more');
  exportBtn.before(moreBtn);
  const morePop = h('div.cc-panel.tl-more-pop', { hidden: true });
  document.body.append(morePop); // outside #timeline, like the other popovers
  loopBtn.dataset.menuLabel = 'Loop';
  shots.playAllBtn.dataset.menuLabel = 'Play all';
  // A control opts into the menu with data-overflow. Each keeps a marker where it sits in the bar, so it goes
  // back to the same place.
  for (const el of [loopBtn, shots.playAllBtn, audioTrack.btn, shotBtn, objKeyBtn]) el.dataset.overflow = '';
  const overflow = [...bar.querySelectorAll(':scope > [data-overflow]')].map((el) => {
    const mark = document.createComment('');
    el.after(mark);
    return { el, mark };
  });
  const FIT_MAX = 4;
  let fitLevel = 0, fitQueued = false;
  function setFit(n) {
    fitLevel = n;
    for (let i = 1; i <= 3; i++) bar.classList.toggle(`is-fit${i}`, i <= n);
    const menu = n >= 4;
    if (menu !== bar.classList.contains('is-fit4')) {
      bar.classList.toggle('is-fit4', menu);
      for (const { el, mark } of overflow) (menu ? morePop : mark.parentNode).insertBefore(el, menu ? null : mark);
    }
  }
  const over = () => bar.scrollWidth > bar.clientWidth + 0.5;
  function fit() {
    fitQueued = false;
    if (!bar.clientWidth) return;
    while (fitLevel > 0) { setFit(fitLevel - 1); if (over()) { setFit(fitLevel + 1); break; } }
    while (fitLevel < FIT_MAX && over()) setFit(fitLevel + 1);
    if (fitLevel < 4 && !morePop.hidden) toggleMore(false);
    fitWatch.takeRecords(); // our own moves are not changes to react to
  }
  const queueFit = () => { if (!fitQueued) { fitQueued = true; requestAnimationFrame(fit); } };
  new ResizeObserver(queueFit).observe(bar);
  const fitWatch = new MutationObserver(queueFit);
  for (const el of [bar, morePop]) fitWatch.observe(el, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'hidden', 'disabled'] });
  document.fonts?.ready.then(queueFit);
  function toggleMore(on = morePop.hidden) {
    if (on) { const r = moreBtn.getBoundingClientRect(); morePop.style.right = `${Math.max(12, innerWidth - r.right)}px`; }
    morePop.hidden = !on;
    moreBtn.classList.toggle('is-open', on);
  }
  // a click on an item does its thing (opening its own popover from where the item is), then the menu closes;
  // Loop and Play all are toggles, so the menu stays open to show their new state
  morePop.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && b !== loopBtn && b !== shots.playAllBtn) toggleMore(false); });
  addEventListener('pointerdown', (e) => { if (!morePop.hidden && !morePop.contains(e.target) && !moreBtn.contains(e.target)) toggleMore(false); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && !morePop.hidden) { e.stopPropagation(); toggleMore(false); } }, true);

  // ---------- track ----------
  const track = h('canvas.tl-track');
  root.append(bar, track, audioTrack.lane);
  const ctx = track.getContext('2d');
  let picked = null; // a shot picked by clicking its bar: Delete removes it
  let drag = null; // { kind: 'key'|'okey'|'scrub', id, t, moved }; a key drag moves every selected key
  // Selected camera keys. store.state.key is the primary one (its ease, lens, time show in the bar);
  // shift-click adds the range from it, ctrl/cmd-click toggles one, and dragging any of them moves them all.
  let selKeys = new Set();
  const syncSel = () => {
    const k = store.state.key;
    if (!k) selKeys.clear();
    else if (!selKeys.has(k)) selKeys = new Set([k]);
    for (const id of selKeys) if (!store.keyById(id)) selKeys.delete(id);
  };

  const dur = () => store.doc.timeline.duration;
  const fps = () => store.doc.timeline.fps;
  const width = () => track.clientWidth;
  // The track stacks the shots, even when there is only one: a row per shot on the shared action-time axis,
  // each shot a bar from where it picks up the action, then a "+ New shot" row. The active shot's row is the
  // full key editor; times stay shot time, so xOf/tOf just add the shot's start. The axis runs a little past
  // the last shot so there is room to see (and draw) where a new one would go.
  // Layout (px): the ruler band, a header column (GUT) with the shots' names, hairline-separated lanes, the
  // new-shot row and a lane for the selected object's keys at the bottom.
  const RULER = 18, ACTIVE_H = 40, ROW_H = 24, NEW_H = 22, GAP = 0, LANE = 16, GUT = 96, INSET = 3, BASE_H = 56;
  let L = null; // { T, end, start, rows: [{ s, top, h }], active, add: { top, h }, height }
  let hoverNew = false; // the pointer is over the new-shot row: preview the shot a click would add
  function relayout() {
    const doc = store.doc;
    if (!doc) { L = null; return; }
    const shots = shotList(doc);
    let end = 0;
    for (const x of shots) end = Math.max(end, (x.timeline.start || 0) + x.timeline.duration);
    for (const o of doc.objects) if (o.anim?.length) end = Math.max(end, o.anim[o.anim.length - 1].t);
    const T = Math.max(1, end + Math.max(1, end * 0.25)); // headroom for the next shot
    let y = RULER;
    const rows = shots.map((x) => { const r = { s: x, top: y, h: x.active ? ACTIVE_H : ROW_H }; y += r.h + GAP; return r; });
    const add = { top: y, h: NEW_H }; y += NEW_H;
    L = { T, end, start: doc.timeline.start || 0, rows, active: rows.find((r) => r.s.active), add, height: y + LANE };
  }
  const inNewRow = (y) => !!L && y >= L.add.top && y < L.add.top + L.add.h;
  /** New shot: snap action time `a` to 0, the playhead, or a shot's start or end within a few px; else a frame. */
  function snapAction(a, e) {
    const marks = [0, L.start + store.state.time];
    for (const r of L.rows) { const st = r.s.timeline.start || 0; marks.push(st, st + r.s.timeline.duration); }
    if (!e?.shiftKey) for (const m of marks) if (Math.abs(xAction(m) - xAction(a)) < 7) return +m.toFixed(3);
    const F = fps(); return +(Math.round(a * F) / F).toFixed(3);
  }
  /** The shot a click on the new-shot row adds: the next one, from where the active shot ends, as long. */
  const nextSpan = () => { const tl = store.doc.timeline; return { a0: (tl.start || 0) + tl.duration, a1: (tl.start || 0) + 2 * tl.duration }; };
  const axisT = () => (L ? L.T : dur());
  const axis0 = () => (L ? L.start : 0);
  const left = () => (L ? GUT : 0) + PAD, span = () => width() - left() - PAD; // the time axis, in px
  const xOf = (t) => left() + ((axis0() + t) / axisT()) * span();
  const tOf = (x, free) => { const t = ((x - left()) / span()) * axisT() - axis0(); return free ? t : Math.max(0, Math.min(dur(), t)); };
  const xAction = (a) => left() + (a / axisT()) * span();
  const aOf = (x) => Math.max(0, ((x - left()) / span()) * axisT()); // action time at x
  const inGutter = (x) => !!L && x < GUT;
  const covers = (s, a) => a >= (s.timeline.start || 0) - 1e-6 && a <= (s.timeline.start || 0) + s.timeline.duration + 1e-6;
  // a shot's bar handle: anywhere on another shot's bar, or the name strip along the top of the active one
  // (its top strip keeps the rest free for keys), or its name in the header column
  const onHandle = (r, x, y) => !!r && y < r.top + r.h && (inGutter(x) || (covers(r.s, aOf(x)) && (!r.s.active || y < r.top + 12)));
  const rowAt = (y) => (L ? L.rows.find((r) => y >= r.top && y < r.top + r.h + GAP) : null);
  const inActive = (y) => !L || (y >= L.active.top && y < L.active.top + L.active.h);
  const snap = (t, e) => (e?.shiftKey ? t : Math.round(t * fps()) / fps());
  const keys = () => [...store.doc.timeline.keys].sort((a, b) => a.t - b.t);
  // While keys are dragged, they (and the other halves of their cuts) are drawn shifted by the drag.
  const liveKeys = () => keys().map((k) => (drag?.kind === 'key' && drag.moving.has(k.id) ? { ...k, t: drag.moving.get(k.id) + drag.dt } : k))
    .sort((a, b) => a.t - b.t);
  /** Cuts: every hold key (except the last) ends a shot, and the camera cuts to the next key. A hold key and
   *  the next key within a frame or so of each other are one "split" key either side of the cut line. */
  const cutsOf = (ks) => {
    const out = [];
    for (let i = 0; i < ks.length - 1; i++) {
      if (!isCut(ks[i])) continue;
      const a = ks[i], b = ks[i + 1], tight = b.t - a.t <= 1.5 / fps() + 1e-6;
      out.push({ a, b, tight, x: tight ? (xOf(a.t) + xOf(b.t)) / 2 : xOf(b.t) - 3 });
    }
    return out;
  };
  const keyXs = (ks) => {
    const xs = new Map(ks.map((k) => [k.id, xOf(k.t)]));
    for (const c of cutsOf(ks)) { if (c.tight) xs.set(c.a.id, c.x - 3); xs.set(c.b.id, c.x + 4); }
    return xs;
  };
  const keyAt = (x, y) => {
    if (y != null && !inActive(y)) return null;
    const ks = liveKeys(), xs = keyXs(ks);
    let best = null, bd = 8;
    for (const k of ks) { const d = Math.abs(xs.get(k.id) - x); if (d < bd) { bd = d; best = k; } }
    return best && keys().find((k) => k.id === best.id);
  };
  /** The other key of a tight cut, so dragging either half moves the cut as one. */
  const cutPartner = (k) => {
    const c = cutsOf(keys()).find((c) => c.tight && (c.a.id === k.id || c.b.id === k.id));
    return c ? (c.a.id === k.id ? c.b : c.a) : null;
  };

  const selObj = () => (store.state.selection && store.object(store.state.selection)) || null;
  // object keys are stored in action time; this shot shows the action from its timeline.start
  const okeys = () => { const t0 = store.doc.timeline.start || 0; return (selObj()?.anim || []).map((k) => ({ ...k, t: +(k.t - t0).toFixed(3) })); };
  const laneY = () => track.clientHeight - (L ? LANE / 2 : 7); // object keys sit in a lane under the camera keys
  const okeyAt = (x, y) => (y > laneY() - 8 ? okeys().find((k) => Math.abs(xOf(drag?.kind === 'okey' && drag.t0 === k.t ? drag.t : k.t) - x) < 7) : null);

  function seek(t) { store.set({ time: Math.max(0, Math.min(dur(), t)), camDirty: false }); }

  track.addEventListener('pointerdown', (e) => {
    const x = e.offsetX;
    if (inNewRow(e.offsetY) && e.button === 0) { // new shot: click adds the next one, drag draws its span
      track.setPointerCapture(e.pointerId);
      const a = inGutter(x) ? null : snapAction(aOf(x), e);
      drag = { kind: 'new', x0: x, a0: a, a1: a, moved: false };
      store.set({ playing: false });
      return draw();
    }
    const ok = okeyAt(x, e.offsetY);
    const k = ok ? null : keyAt(x, e.offsetY);
    track.setPointerCapture(e.pointerId);
    const row = !ok && !k && rowAt(e.offsetY);
    // a shot's bar: click to pick it (and put the playhead there), drag sideways to change where it picks
    // up the action, drag up or down to reorder the sequence
    if (row && e.button === 0 && onHandle(row, x, e.offsetY)) {
      drag = { kind: 'shot', gut: inGutter(x), s: row.s, x0: x, y0: e.offsetY, from: L.rows.indexOf(row), to: L.rows.indexOf(row), start0: row.s.timeline.start || 0, moved: false, axis: null };
      store.set({ playing: false });
      return;
    }
    if (!ok && !k) picked = null;
    if (!ok && !k && inGutter(x)) return; // the header column is not time
    if (ok && e.button === 0) {
      drag = { kind: 'okey', id: selObj().id, t: ok.t, t0: ok.t, moved: false };
      store.set({ playing: false });
      seek(ok.t);
    } else if (k && e.button === 0) {
      syncSel();
      const anchor = store.state.key && store.keyById(store.state.key);
      let collapse = false; // a plain click on a key of a multi-selection keeps it for dragging, then selects just that key
      if (e.shiftKey && anchor) {
        const [lo, hi] = [Math.min(anchor.t, k.t), Math.max(anchor.t, k.t)];
        for (const x of keys()) if (x.t >= lo - 1e-6 && x.t <= hi + 1e-6) selKeys.add(x.id);
      } else if (e.ctrlKey || e.metaKey) {
        if (selKeys.has(k.id) && selKeys.size > 1) {
          selKeys.delete(k.id);
          store.set({ key: k.id === store.state.key ? [...selKeys][0] : store.state.key });
          return draw();
        }
        selKeys.add(k.id);
      } else if (selKeys.has(k.id) && selKeys.size > 1) collapse = true;
      else selKeys = new Set([k.id]);
      // move the selection and the other half of any cut it touches
      const moving = new Map();
      for (const id of selKeys) { const x = store.keyById(id); if (!x) continue; moving.set(id, x.t); const p = cutPartner(x); if (p) moving.set(p.id, p.t); }
      const ts = [...moving.values()];
      drag = { kind: 'key', id: k.id, t: k.t, t0: k.t, dt: 0, moved: false, moving, collapse, shift0: e.shiftKey, lo: -Math.min(...ts), hi: dur() - Math.max(...ts) };
      store.set({ key: k.id });
      picked = null;
      if (!e.shiftKey && !e.ctrlKey && !e.metaKey) seek(k.t);
    } else if (e.button === 0) {
      drag = { kind: 'scrub', moved: false };
      store.set({ playing: false });
      scrubTo(x, e);
    }
  });
  track.addEventListener('pointermove', (e) => {
    if (!drag) {
      const r = rowAt(e.offsetY), hn = inNewRow(e.offsetY);
      track.style.cursor = hn ? 'pointer' : okeyAt(e.offsetX, e.offsetY) || keyAt(e.offsetX, e.offsetY) || onHandle(r, e.offsetX, e.offsetY) ? 'grab' : 'default';
      if (hn !== hoverNew) { hoverNew = hn; draw(); }
      return;
    }
    if (drag.kind === 'new') {
      if (drag.a0 == null) return; // pressed on the row's name: a click
      if (!drag.moved && Math.abs(e.offsetX - drag.x0) < 4) return;
      drag.moved = true;
      drag.a1 = Math.min(L.T, snapAction(aOf(e.offsetX), e));
      return draw();
    }
    if (drag.kind === 'shot') {
      const dx = e.offsetX - drag.x0, dy = e.offsetY - drag.y0;
      if (!drag.moved && (drag.gut ? Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy))) < 4) return;
      if (!drag.moved) drag.axis = drag.gut || Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
      drag.moved = true;
      track.style.cursor = drag.axis === 'y' ? 'ns-resize' : 'grabbing';
      if (drag.axis === 'y') { // reorder: the lane under the pointer
        const ys = L.rows.map((r) => r.top + r.h / 2);
        let to = 0; for (let i = 0; i < ys.length; i++) if (Math.abs(e.offsetY - ys[i]) < Math.abs(e.offsetY - ys[to])) to = i;
        drag.to = to;
        return draw();
      }
      const F = drag.s.timeline.fps;
      let st = Math.max(0, drag.start0 + ((e.offsetX - drag.x0) / span()) * axisT());
      if (!e.shiftKey) st = Math.round(st * F) / F;
      drag.start = +st.toFixed(3);
      return draw();
    }
    drag.moved = true;
    const t = snap(tOf(e.offsetX), e);
    if (drag.kind === 'key') {
      drag.dt = Math.max(drag.lo, Math.min(drag.hi, snap(tOf(e.offsetX, true), drag.shift0 ? null : e) - drag.t0));
      drag.t = drag.t0 + drag.dt; seek(drag.t);
    } else if (drag.kind === 'okey') { drag.t = t; seek(t); }
    else scrubTo(e.offsetX, e);
    draw();
  });
  track.addEventListener('pointerup', (e) => {
    const d = drag; drag = null;
    if (!d) return;
    if (d.kind === 'new') {
      const lo = Math.min(d.a0 ?? 0, d.a1 ?? 0), hi = Math.max(d.a0 ?? 0, d.a1 ?? 0);
      if (d.moved && hi - lo >= 1 / fps() - 1e-6) shots.add({ start: lo, duration: +(hi - lo).toFixed(3) });
      else shots.add();
      return draw();
    }
    if (d.kind === 'shot') {
      if (d.moved && d.axis === 'y') { if (d.to !== d.from) store.op({ op: 'shot.move', id: d.s.id, to: d.to + 1 }, 'reorder shots').catch(() => {}); draw(); return; }
      if (d.moved) { if (Math.abs(d.start - d.start0) > 1e-4) store.op({ op: 'timeline', start: d.start, shot: d.s.id }, 'shot action start').catch(() => {}); draw(); return; }
      // a click picks the shot (Delete removes it) and puts the playhead where it was clicked
      picked = d.s.id; selKeys.clear(); store.set({ key: null });
      playAt(d.s, d.gut ? L.start + store.state.time : aOf(e.offsetX), e); // from its name: stay at this moment
      return draw();
    }
    if (d.kind === 'key' && d.moved && Math.abs(d.dt) > 1e-4) {
      const ops = [...d.moving].map(([id, t0]) => ({ op: 'key.update', id, t: +(t0 + d.dt).toFixed(3) }));
      const n = selKeys.size;
      store.op(ops, n > 1 ? `move ${n} keys` : ops.length > 1 ? 'move cut' : 'retime key').catch(() => {});
    } else if (d.kind === 'key' && d.collapse) { selKeys = new Set([d.id]); }
    if (d.kind === 'okey' && d.moved && Math.abs(d.t - d.t0) > 1e-4) {
      const k = okeys().find((x) => Math.abs(x.t - d.t0) < 1e-3);
      if (k) store.op([{ op: 'anim.remove', id: d.id, t: d.t0 }, { op: 'anim.key', id: d.id, t: +d.t.toFixed(3), position: k.position, rotation: k.rotation, scale: k.scale, ease: k.ease }], `retime ${d.id} key`).catch(() => {});
    }
    if (d.kind === 'scrub' && !d.moved && !keyAt(e.offsetX, e.offsetY)) { selKeys.clear(); store.set({ key: null }); }
    draw();
  });
  track.addEventListener('pointerleave', () => { if (hoverNew) { hoverNew = false; draw(); } });
  track.addEventListener('dblclick', (e) => {
    if (!inActive(e.offsetY) || onHandle(rowAt(e.offsetY), e.offsetX, e.offsetY)) return; // keys go on the active shot's row
    if (!keyAt(e.offsetX, e.offsetY)) keyFromView(snap(tOf(e.offsetX), e));
  });
  track.addEventListener('contextmenu', (e) => {
    if (e.ctrlKey && !e.button) { e.preventDefault(); return; } // macOS ctrl-click is a selection toggle, not a right-click
    const r = rowAt(e.offsetY);
    if (onHandle(r, e.offsetX, e.offsetY)) { e.preventDefault(); removeShot(r.s.id); return; }
    const ok = okeyAt(e.offsetX, e.offsetY);
    if (ok) { e.preventDefault(); store.op({ op: 'anim.remove', id: selObj().id, t: ok.t }, 'remove object key').catch(() => {}); return; }
    const k = keyAt(e.offsetX, e.offsetY); if (k) { e.preventDefault(); if (!selKeys.has(k.id)) { selKeys = new Set([k.id]); store.set({ key: k.id }); } deleteKey(); } });

  // ---------- actions ----------
  /** Several shots: put the playhead at action time `a`, in shot `s` (switching to it if it isn't active). */
  let switching = null, pendingAt = null;
  function playAt(s, a, e) {
    const tl = s.timeline, F = tl.fps;
    let t = Math.max(0, Math.min(tl.duration, a - (tl.start || 0)));
    if (!e?.shiftKey) t = Math.round(t * F) / F;
    if (s.id === store.doc.shot) return seek(t);
    if (switching) { pendingAt = [s, a, e]; return; } // scrubbing across a cut: catch up once the switch lands
    switching = shots.use(s.id).then(() => store.set({ time: t })).finally(() => {
      switching = null;
      const p = pendingAt; pendingAt = null;
      if (p) { relayout(); const s2 = L?.rows.find((r) => r.s.id === p[0].id)?.s; if (s2) playAt(s2, p[1], p[2]); }
    });
  }
  /** Scrub to x: one shot, in its time. Several: the action time at x, in the active shot if it covers it,
   *  else the first shot that does, so the ruler and the empty parts of the rows are scrubbable too. */
  function scrubTo(x, e) {
    if (!L) return seek(snap(tOf(x), e));
    const a = aOf(x), cur = L.active.s;
    const s = covers(cur, a) ? cur : L.rows.map((r) => r.s).find((x) => covers(x, a)) || cur;
    playAt(s, a, e);
  }
  function removeShot(id) {
    if (store.doc.shots.length < 2) return toast('A scene needs at least one shot');
    const s = store.doc.shots.find((x) => x.id === id);
    picked = null;
    store.op({ op: 'shot.remove', id }, 'delete shot').then(() => toast(`Deleted ${s?.name || id}. Undo brings it back`)).catch(() => {});
  }
  async function keyObject(t = store.state.time) {
    const o = selObj();
    if (!o) return;
    await store.op({ op: 'anim.key', id: o.id, t: +t.toFixed(3) }, `key ${o.id}`);
    toast(o.anim?.length ? `Keyed ${o.id} at ${t.toFixed(2)}s` : `Keyed ${o.id} at ${t.toFixed(2)}s. Move the playhead, then drag it to key the next spot`);
  }

  async function keyFromView(t = store.state.time) {
    const p = viewport.getPose();
    const [r] = await store.op({ op: 'key.add', t: +t.toFixed(3), position: p.position, target: p.target, fov: p.fov, roll: p.roll }, 'key camera');
    store.set({ key: r.id, camDirty: false });
    toast(r.replaced ? `Updated key at ${t.toFixed(2)}s` : `Keyed camera at ${t.toFixed(2)}s`);
  }
  function updateKey(patch) {
    const id = store.state.key;
    if (!id) return;
    store.op({ op: 'key.update', id, ...patch }, 'edit key').then(() => store.set({ camDirty: false })).catch(() => {});
  }
  function deleteKey() {
    const id = store.state.key;
    if (!id) { if (picked) removeShot(picked); return; }
    syncSel();
    const ids = [...selKeys];
    store.op(ids.map((id) => ({ op: 'key.remove', id })), ids.length > 1 ? `delete ${ids.length} keys` : 'delete key')
      .then(() => { selKeys.clear(); store.set({ key: null }); }).catch(() => {});
  }

  // ---------- drawing ----------
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  /** The ruler band: labels against the top, a tick beside each, frame ticks along the hairline under it.
   *  `xf` maps seconds to px; labels that would run into a cut's scissors (`cuts`) are left out. */
  function drawRuler(W, T, xf, F, { dim, line }, cuts = []) {
    const x0 = xf(0), pxPerSec = (xf(T) - x0) / T;
    const step = pxPerSec > 120 ? 0.5 : pxPerSec > 40 ? 1 : pxPerSec > 16 ? 2 : 5;
    ctx.fillStyle = line; ctx.fillRect(L ? GUT : 0, RULER, W, 1);
    ctx.fillStyle = dim;
    if (F && pxPerSec / F > 5) { // frame ticks
      ctx.globalAlpha = 0.45;
      for (let f = 0; f <= T * F + 1e-6; f++) ctx.fillRect(Math.round(xf(f / F)), RULER - 3, 1, 3);
      ctx.globalAlpha = 1;
    }
    for (let t = 0; t <= T + 1e-6; t += step) {
      const x = Math.round(xf(t));
      ctx.globalAlpha = 0.6; ctx.fillRect(x, 3, 1, RULER - 3); ctx.globalAlpha = 1;
      const label = `${+t.toFixed(1)}s`, w = ctx.measureText(label).width;
      const lx = x + 4 + w > W - 3 ? x - 4 - w : x + 4; // the last label sits left of its tick rather than clip
      if (!cuts.some((c) => lx < c.x + 11 && lx + w > c.x - 9)) ctx.fillText(label, lx, 3);
    }
  }

  /** Several shots: header column, action-time ruler and a lane per shot (the active lane's keys are drawn
   *  by draw()). Inactive shots are quiet bars with their keys as ticks; accent marks only the active one. */
  function drawStack(W, H0, { text, dim, line, accent }) {
    const soft = css('--cc-accent-soft'), font = css('--cc-font'), mono = css('--cc-mono');
    const reorder = drag?.kind === 'shot' && drag.axis === 'y';
    // structure: the active lane's header cell, lane hairlines, the header column's edge
    const act = L.active;
    ctx.fillStyle = text; ctx.globalAlpha = 0.05; ctx.fillRect(0, act.top + 1, GUT, act.h - 1); ctx.globalAlpha = 1;
    ctx.fillStyle = accent; ctx.fillRect(0, act.top + 1, 2, act.h - 1);
    ctx.fillStyle = line;
    for (const r of L.rows) ctx.fillRect(0, r.top + r.h, W, 1);
    ctx.fillRect(0, L.add.top + L.add.h, W, 1);
    ctx.fillRect(GUT, 0, 1, H0);
    drawRuler(W, L.T, xAction, 0, { dim, line });
    // faint gridlines carry the ruler's ticks down through the lanes
    const step = (xAction(L.T) - xAction(0)) / L.T > 40 ? 1 : 5;
    ctx.fillStyle = line; ctx.globalAlpha = 0.6;
    for (let a = 0; a <= L.T + 1e-6; a += step) ctx.fillRect(Math.round(xAction(a)), RULER + 1, 1, H0 - RULER - 1);
    ctx.globalAlpha = 1;
    ctx.textBaseline = 'middle';
    for (const [i, r] of L.rows.entries()) {
      const tl = r.s.timeline, my = r.top + r.h / 2 + 1;
      const st = drag?.kind === 'shot' && drag.moved && drag.axis === 'x' && drag.s.id === r.s.id ? drag.start : tl.start || 0;
      const x0 = xAction(st), bw = Math.max(3, xAction(st + tl.duration) - x0), by = r.top + 1 + INSET, bh = r.h - 1 - INSET * 2;
      const lifted = reorder && drag.s.id === r.s.id;
      // header: position in the sequence, then the name
      ctx.save(); ctx.beginPath(); ctx.rect(0, r.top, GUT - 8, r.h); ctx.clip();
      ctx.globalAlpha = lifted ? 0.4 : 1;
      ctx.font = `10px ${mono}`; ctx.fillStyle = dim; ctx.fillText(String(i + 1), 12, my);
      ctx.font = `${r.s.active ? 500 : 400} 11px ${font}`; ctx.fillStyle = r.s.active ? text : dim; ctx.fillText(r.s.name, 28, my);
      ctx.restore();
      // the shot: a bar from where it picks up the action
      ctx.globalAlpha = lifted ? 0.4 : 1;
      ctx.beginPath(); ctx.roundRect(x0, by, bw, bh, 3);
      if (r.s.active) { ctx.fillStyle = soft; ctx.fill(); }
      else { ctx.save(); ctx.fillStyle = text; ctx.globalAlpha *= 0.08; ctx.fill(); ctx.restore(); }
      if (r.s.id === picked) { ctx.strokeStyle = r.s.active ? accent : dim; ctx.lineWidth = 1; ctx.stroke(); }
      if (!r.s.active) { // its camera keys, as ticks
        ctx.fillStyle = text; ctx.globalAlpha *= 0.3;
        for (const k of tl.keys) if (k.t > 1e-6 && k.t < tl.duration - 1e-6) ctx.fillRect(Math.round(xAction(st + k.t)), by + 4, 1, bh - 8);
      }
      ctx.globalAlpha = 1;
    }
    drawNewRow(W, { text, dim, line, accent, font, mono });
    // the selected object's key lane is named after it
    const so = selObj();
    if (so?.anim?.length) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, H0 - LANE, GUT - 8, LANE); ctx.clip();
      ctx.font = `10px ${mono}`; ctx.fillStyle = dim; ctx.fillText(so.id, 12, laneY() + 1);
      ctx.restore();
    }
    // reordering: where the dragged shot will land
    if (reorder && drag.to !== drag.from) {
      const r = L.rows[drag.to];
      ctx.fillStyle = accent; ctx.fillRect(0, (drag.to < drag.from ? r.top : r.top + r.h) - 0.5, W, 2);
    }
    ctx.textBaseline = 'top';
    ctx.font = `10px ${mono}`;
  }

  /** The "+ New shot" row: its name in the header column and, while hovered or drawn, a dashed preview of
   *  the shot a click (the next one) or the drag (any span) would add, labelled with where it starts. */
  function drawNewRow(W, { text, dim, line, accent, font, mono }) {
    const r = L.add, my = r.top + r.h / 2 + 1, live = drag?.kind === 'new';
    const span = live && drag.moved ? { a0: Math.min(drag.a0, drag.a1), a1: Math.max(drag.a0, drag.a1) } : hoverNew || live ? nextSpan() : null;
    if (span) { ctx.fillStyle = accent; ctx.globalAlpha = 0.06; ctx.fillRect(0, r.top + 1, W, r.h - 1); ctx.globalAlpha = 1; }
    // header: a plus and the row's name
    const on = !!span;
    ctx.strokeStyle = on ? accent : dim; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(10, my); ctx.lineTo(18, my); ctx.moveTo(14, my - 4); ctx.lineTo(14, my + 4); ctx.stroke();
    ctx.lineWidth = 1; ctx.lineCap = 'butt';
    ctx.font = `400 11px ${font}`; ctx.fillStyle = on ? text : dim; ctx.fillText('New shot', 28, my);
    if (!span) return;
    const x0 = xAction(span.a0), x1 = Math.min(W - 2, xAction(span.a1)), by = r.top + 1 + INSET, bh = r.h - 1 - INSET * 2;
    ctx.save(); ctx.beginPath(); ctx.rect(GUT + 1, r.top, W - GUT - 1, r.h); ctx.clip();
    ctx.beginPath(); ctx.roundRect(x0 + 0.75, by + 0.75, Math.max(2, x1 - x0 - 1.5), bh - 1.5, 3);
    ctx.fillStyle = accent; ctx.globalAlpha = 0.08; ctx.fill(); ctx.globalAlpha = 1;
    ctx.setLineDash([4, 3]); ctx.strokeStyle = accent; ctx.lineWidth = 1.5; ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    // what it is: next shot, the same moment again, or from the playhead (else just its times)
    const n = store.doc.shots.length + 1, ph = L.start + store.state.time, near = (a, b) => Math.abs(a - b) < 1e-3;
    const tl = store.doc.timeline, endA = (tl.start || 0) + tl.duration;
    const what = near(span.a0, endA) ? 'next shot' : near(span.a0, tl.start || 0) ? 'same moment, new angle' : near(span.a0, ph) ? 'from the playhead' : 'new angle';
    const label = `Shot ${n} · ${what}, ${span.a0.toFixed(2)} → ${span.a1.toFixed(2)} s`;
    ctx.font = `500 10.5px ${font}`; ctx.fillStyle = text;
    ctx.fillText(label, x0 + 8, my);
    ctx.restore();
    // a guide down through the lanes where it starts
    ctx.strokeStyle = accent; ctx.globalAlpha = 0.7; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, RULER); ctx.lineTo(Math.round(x0) + 0.5, r.top); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.font = `10px ${mono}`;
  }

  function draw() {
    if (!store.doc) return;
    const dpr = devicePixelRatio || 1;
    relayout();
    const W = track.clientWidth, H0 = track.clientHeight;
    if (track.width !== Math.round(W * dpr) || track.height !== Math.round(H0 * dpr)) { track.width = Math.round(W * dpr); track.height = Math.round(H0 * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H0);
    const text = css('--cc-text'), dim = css('--cc-text-faint'), line = css('--cc-line'), accent = css('--cc-accent');
    const D = dur(), F = fps();
    ctx.font = `10px ${css('--cc-mono')}`;
    ctx.textBaseline = 'top';
    if (L) drawStack(W, H0, { text, dim, line, accent });
    const H = L ? L.active.h : H0; // the key editor: the whole track, or the active shot's row
    // inside it: `ct`..`cb` is where shots' bands and cut lines run (under the ruler, or within the bar),
    // and the keys sit on `mid`
    const ct = L ? 12 : RULER + 1, cb = L ? H - INSET : H;
    const mid = L ? H / 2 + 2 : RULER + Math.round((H - RULER) / 2);

    const ks = liveKeys();
    const cuts = cutsOf(ks), xs = keyXs(ks);
    if (L) { ctx.save(); ctx.translate(0, L.active.top); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip(); }

    // ruler (one shot: in shot time; several: the stack's action-time ruler is drawn above)
    if (!L) drawRuler(W, D, xOf, F, { dim, line }, cuts);
    // shots and cuts: every hold key (but the last) ends a shot and the camera cuts to the next key.
    // With at least one cut, shots get a faint alternating band and a name; the baseline breaks at each cut.
    const edges = [xOf(0), ...cuts.map((c) => c.x), xOf(D)];
    ctx.fillStyle = text; ctx.globalAlpha = 0.045;
    for (let i = 1; i < edges.length - 1; i += 2) ctx.fillRect(edges[i], ct, edges[i + 1] - edges[i], cb - ct);
    ctx.globalAlpha = 1;
    ctx.fillStyle = line;
    for (let i = 0; i < edges.length - 1; i++) {
      const x0 = edges[i] + (i ? 7 : 0), x1 = edges[i + 1] - (i < edges.length - 2 ? 7 : 0);
      if (x1 > x0) ctx.fillRect(x0, mid, x1 - x0, 1);
    }
    // a long hold before a cut (the shot ends on a still): dotted from the hold key to the cut
    ctx.strokeStyle = dim; ctx.setLineDash([2, 3]); ctx.beginPath();
    for (const c of cuts) if (!c.tight && c.x - xs.get(c.a.id) > 10) { ctx.moveTo(xs.get(c.a.id) + 6, mid + 0.5); ctx.lineTo(c.x - 6, mid + 0.5); }
    ctx.stroke(); ctx.setLineDash([]);

    // shot speed curve, faint, across the whole track
    const speed = resolveEase(store.doc.timeline.speed ?? 'linear');
    if (easeName(speed) !== 'linear') {
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.25; ctx.beginPath();
      for (let i = 0; i <= 80; i++) { const u = i / 80; const y = cb - 4 - bezier(speed, u) * (cb - ct - 6); i ? ctx.lineTo(xOf(u * D), y) : ctx.moveTo(xOf(u * D), y); }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // selected segment only: a soft "speed hump" showing how fast the camera moves from the selected key
    // to the next. Flat band = constant speed, a hill = speeds up then slows. Dotted = hold.
    const si = ks.findIndex((k) => k.id === store.state.key);
    if (si >= 0 && si < ks.length - 1) {
      const a = ks[si], b = ks[si + 1];
      const x0 = xs.get(a.id), x1 = xs.get(b.id);
      const e = resolveEase(a.ease);
      if (e === 'hold') {
        ctx.strokeStyle = accent; ctx.globalAlpha = 0.8; ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.moveTo(x0, mid + 0.5); ctx.lineTo(x1, mid + 0.5); ctx.stroke();
        ctx.setLineDash([]); ctx.globalAlpha = 1;
      } else if (x1 - x0 >= 6) {
        const room = mid - ct - 3, k = Math.min(10, room / 2.2); // linear sits at k px; peaks clamp to the room above the line
        const n = Math.max(16, Math.round((x1 - x0) / 3));
        const pts = [];
        for (let j = 0; j <= n; j++) {
          const u = j / n, v = bezierSpeed(e, u, 0.004);
          pts.push([x0 + u * (x1 - x0), mid - Math.max(-6, Math.min(room, v * k))]);
        }
        ctx.beginPath(); ctx.moveTo(x0, mid);
        for (const [x, y] of pts) ctx.lineTo(x, y);
        ctx.lineTo(x1, mid); ctx.closePath();
        ctx.fillStyle = accent; ctx.globalAlpha = 0.16; ctx.fill();
        ctx.globalAlpha = 0.9; ctx.strokeStyle = accent; ctx.beginPath();
        pts.forEach(([x, y], j) => (j ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke(); ctx.globalAlpha = 1;
      }
    }

    // shot names, then the cut lines with a scissors tab over the ruler
    if (cuts.length) {
      ctx.font = `500 10px ${css('--cc-font')}`; ctx.fillStyle = dim;
      for (let i = 0; i < edges.length - 1; i++) if (edges[i + 1] - edges[i] >= 56) ctx.fillText(`Shot ${i + 1}`, edges[i] + (i ? 7 : 2), ct + 2);
      ctx.font = `10px ${css('--cc-mono')}`;
    }
    const sunk = css('--cc-surface-sunk');
    for (const c of cuts) {
      const x = Math.round(c.x) + 0.5;
      ctx.fillStyle = text; ctx.fillRect(x - 0.75, ct, 1.5, cb - ct);
      ctx.save(); ctx.translate(0, ct - 12); // the scissors tab sits in the 12 px above the cut line
      ctx.fillStyle = sunk; if (!L) ctx.fillRect(x - 7, 0, 14, 12);
      ctx.strokeStyle = text; ctx.lineWidth = 1.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.arc(x - 2.8, 8.6, 1.8, 0, Math.PI * 2); ctx.moveTo(x + 4.6, 8.6); ctx.arc(x + 2.8, 8.6, 1.8, 0, Math.PI * 2);
      ctx.moveTo(x - 1.5, 7.2); ctx.lineTo(x + 2.8, 1.2); ctx.moveTo(x + 1.5, 7.2); ctx.lineTo(x - 2.8, 1.2);
      ctx.stroke(); ctx.lineWidth = 1; ctx.lineCap = 'butt';
      ctx.restore();
    }

    // keys. At a cut the pair becomes one split key: half square = the shot ends, half diamond = the next starts.
    const cutA = new Map(cuts.filter((c) => c.tight).map((c) => [c.a.id, c])), cutB = new Map(cuts.map((c) => [c.b.id, c]));
    for (const k of ks) {
      const x = xs.get(k.id), sel = selKeys.has(k.id), r = sel ? 6 : 5;
      ctx.beginPath();
      if (cutA.has(k.id)) { const cx = Math.round(cutA.get(k.id).x) + 0.5; ctx.rect(cx - 1.5 - (r - 0.5), mid - r + 1, r - 0.5, 2 * r - 2); }
      else if (cutB.has(k.id)) { const cx = Math.round(cutB.get(k.id).x) + 0.5; ctx.moveTo(cx + 1.5, mid - r); ctx.lineTo(cx + 1.5 + r, mid); ctx.lineTo(cx + 1.5, mid + r); ctx.closePath(); }
      else if (k.ease === 'hold') ctx.rect(x - r + 1, mid - r + 1, 2 * r - 2, 2 * r - 2);
      else { ctx.moveTo(x, mid - r); ctx.lineTo(x + r, mid); ctx.lineTo(x, mid + r); ctx.lineTo(x - r, mid); ctx.closePath(); }
      ctx.fillStyle = sel ? accent : text;
      ctx.fill();
    }

    if (L) ctx.restore();

    // selected object's keys, in a lane under the camera keys
    const oks = okeys();
    if (oks.length) {
      const y = laneY();
      const pts = oks.map((k) => (drag?.kind === 'okey' && Math.abs(drag.t0 - k.t) < 1e-3 ? drag.t : k.t)).sort((a, b) => a - b);
      ctx.fillStyle = accent; ctx.globalAlpha = 0.35;
      if (pts.length > 1) ctx.fillRect(xOf(pts[0]), y - 0.5, xOf(pts[pts.length - 1]) - xOf(pts[0]), 1.5);
      ctx.globalAlpha = 1;
      for (const t of pts) {
        ctx.beginPath(); ctx.arc(xOf(t), y, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = css('--cc-surface-solid'); ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = accent; ctx.stroke(); ctx.lineWidth = 1;
      }
    }

    // playhead
    const px = Math.round(xOf(store.state.time));
    ctx.fillStyle = accent;
    ctx.fillRect(px, 0, 1.5, H0);
    ctx.beginPath(); ctx.moveTo(px - 4, 0); ctx.lineTo(px + 5.5, 0); ctx.lineTo(px + 0.75, 6); ctx.closePath(); ctx.fill();
  }

  // ---------- bar state ----------
  function refresh() {
    if (!store.doc) return;
    const tl = store.doc.timeline;
    const t = store.state.time;
    timeNow.textContent = t.toFixed(2);
    timeDur.textContent = ` / ${tl.duration.toFixed(2)} s`;
    frameEl.textContent = `f${Math.round(t * tl.fps)}`;
    // only swap the icon when play state flips: refresh runs every frame while playing, and replacing the
    // icon under the pointer between mousedown and mouseup swallows the click.
    if (playBtn.dataset.playing !== String(!!store.state.playing)) {
      playBtn.dataset.playing = String(!!store.state.playing);
      playBtn.replaceChildren(icon(store.state.playing ? 'pause' : 'play'));
      playBtn.title = store.state.playing ? 'Pause (Space)' : 'Play (Space)';
    }
    loopBtn.setActive(store.state.loop);
    viewSeg.value = store.state.view;
    keyBtn.setActive(store.state.camDirty);
    keyBtn.title = store.state.camDirty ? 'The camera moved: press K to key this framing' : 'Key the current view at the playhead (K)';
    shotDur.textContent = tl.duration.toFixed(2);
    shotFps.textContent = fmtFps(tl.fps);
    syncSel();
    const k = store.state.key && store.keyById(store.state.key);
    keyGroup.style.display = k ? '' : 'none';
    const multi = selKeys.size > 1;
    easeBtn.style.display = toViewBtn.style.display = multi ? 'none' : ''; // .cc-btn sets display, so hidden alone would not hide it
    delKeyBtn.title = multi ? `Delete ${selKeys.size} keys` : 'Delete key';
    if (k) {
      const sorted = keys();
      const i = sorted.findIndex((x) => x.id === k.id);
      const last = i === sorted.length - 1;
      keyTime.textContent = multi ? `${selKeys.size} keys` : `${k.t.toFixed(2)} s`;
      keyTime.title = multi ? 'Drag any selected key to move them all. Shift-click selects a range, Ctrl/Cmd-click adds or removes one' : `Key ${k.id}`;
      changed(easeGlyph, last ? 'linear' : k.ease, () => { easeGlyph.innerHTML = easeSvg(last ? 'linear' : k.ease); });
      easeName_.textContent = last ? 'last key' : easeName(k.ease);
      easeBtn.disabled = last;
      easeBtn.title = last ? 'Last key: no segment after it' : 'Easing from this key to the next (opens the curve editor)';
      // selecting a key (or the agent changing its lens) puts the free view on that lens too
      changed(lensField, [k.id, k.fov], () => viewport.setFreeFov(k.fov));
      changed(rollField, [k.id, k.roll], () => { viewport.freeRoll = k.roll || 0; });
    }
    const so = selObj();
    objKeyBtn.hidden = !so;
    if (so) {
      objKeyLabel.textContent = `Key ${so.id}`;
      const n = so.anim?.length || 0;
      objKeyBtn.title = n ? `${so.id} has ${n} key${n === 1 ? '' : 's'} (circles under the track). Key it at the playhead; dragging it with the gizmo also keys it` : `Start animating ${so.id}: key where it is now at the playhead`;
      objKeyBtn.classList.toggle('is-animated', !!n);
    }
    const shotView = store.state.view === 'shot';
    // the live camera wins while it is being changed by hand (Ctrl/Cmd + scroll, or a hand-framed shot)
    const lensFov = shotView ? (store.state.camDirty ? viewport.shotCam.fov : k ? k.fov : (sampleCamera(store.doc.timeline, store.state.time)?.fov ?? viewport.freeCam.fov)) : viewport.freeCam.fov;
    lensNum.set(Math.round(fovToLens(lensFov)));
    const lensOff = shotView && !k;
    lensField.classList.toggle('is-disabled', lensOff);
    lensNum.disabled = lensOff;
    const roll = shotView ? (store.state.camDirty ? viewport.shotRoll : k ? k.roll : (sampleCamera(store.doc.timeline, store.state.time)?.roll ?? 0)) : viewport.freeRoll;
    rollNum.set(Math.round(roll || 0));
    rollField.classList.toggle('is-disabled', lensOff && !store.state.camDirty);
    rollNum.disabled = lensOff && !store.state.camDirty;
    rollField.title = rollNum.disabled ? 'Select a key to change its roll (or hold the right mouse button and press Z / X)' : k ? 'Roll (Dutch tilt) of the selected key; the free view uses it too' : 'Roll (Dutch tilt) of the view; new keys get it';
    lensField.title = lensOff ? 'Select a key to change its lens' : k ? 'Lens of the selected key; the free view uses it too' : 'Lens of the free view; new keys get it';
    exportBtn.disabled = store.state.exporting;
    exportBtn.title = store.doc.shots.length > 1 ? 'Render this shot (mp4). Shift-click: every shot in order, cut together into one video' : 'Render the blockout video (mp4)';
    draw();
    audioTrack.refresh();
    curve.refresh();
    shot.refresh();
    shots.refresh();
    // the track grows to fit the stacked shots
    relayout();
    const extra = L ? Math.max(0, L.height - BASE_H) : 0;
    if (extra !== lastExtra) { lastExtra = extra; document.documentElement.style.setProperty('--stack-h', `${extra}px`); requestAnimationFrame(draw); }
  }
  let lastExtra = 0;

  // ---------- curve editor + shot settings ----------
  const curve = mountCurveEditor(root, { updateKey, keys, onToggle: (open, mode) => { easeBtn.classList.toggle('is-open', open && mode === 'segment'); }, anchor: () => easeBtn });
  const shot = mountShotSettings(root, { anchor: shotBtn, keys, openSpeed: () => { shot.toggle(false); curve.toggle(true, 'speed'); } });


  store.on('doc', refresh);
  store.on('state', refresh);
  new ResizeObserver(draw).observe(track);
  return { refresh, keyFromView, seek, xAt: (t) => xOf(t), yAt: () => (L ? L.active.top + L.active.h / 2 + 2 : 0), newRowY: () => (L ? L.add.top + L.add.h / 2 : 0), xAction: (a) => xAction(a), deleteKey, draw, loadAudio: audioTrack.loadFile, shots };
}

/** Popover with a draggable cubic-bezier for the segment at the playhead, or the shot-wide speed curve. */
function mountCurveEditor(root, { updateKey, keys, onToggle, anchor }) {
  // canvas layout: the curve on top, a speed strip under it, sharing one time axis
  const W = 276, H = 184, L = 18, R = W - 10, T = 10, CB = 124, ST = 136, SB = H - 6;
  const cv = h('canvas.curve-canvas', { width: W * 2, height: H * 2, style: { width: `${W}px`, height: `${H}px` } });
  const ctx = cv.getContext('2d');
  let mode = 'segment';
  const tabs = segmented({ options: [{ value: 'segment', label: 'Camera', title: 'How the camera moves from this key to the next' }, { value: 'speed', label: 'Playback', title: 'Playback speed of the whole shot: slow motion and fast forward for the camera and everything in it' }], value: mode, onChange: (v) => { mode = v; onToggle?.(api.open, mode); refresh(); } });
  const title = h('span.cc-label.cc-mono');
  const nameEl = h('span.curve-name');
  const presets = h('div.curve-presets');
  const help = h('div.curve-help.cc-label');
  const closeBtn = button({ icon: 'close', kind: 'ghost', title: 'Close', onClick: () => toggle(false) });
  // copy this segment's ease to every other segment (cuts stay cuts), as one undo step
  const allBtn = button({ label: 'Apply to all segments', kind: 'ghost', title: 'Give every segment this ease. Cuts stay cuts.', onClick: () => {
    const tg = target();
    if (!tg || tg.kind !== 'segment') return;
    store.op({ op: 'key.easeAll', from: tg.key.id }, 'ease all segments')
      .then((res) => toast(`${easeName(tg.ease)} on ${res[0].updated} segments`)).catch(() => {});
  } });
  allBtn.classList.add('curve-all');
  const pop = h('div.cc-panel.curve-pop', { hidden: true },
    h('div.cc-row', {}, tabs, h('span.cc-spacer'), closeBtn),
    h('div.cc-row.curve-head', {}, title, nameEl),
    cv, presets, allBtn, help);
  root.append(pop);

  let live = null;    // bezier being dragged
  let dragging = -1;  // handle index being dragged
  let hover = -1;     // handle index under the pointer
  let preview = null; // preset name under the pointer, drawn as a ghost
  let lo = 0, hi = 1; // visible progress range; grows past [0, 1] only when the curve does
  const api = { open: false, toggle, refresh };

  const toX = (x) => L + x * (R - L);
  const toY = (y) => CB - ((y - lo) / (hi - lo)) * (CB - T);
  const fromX = (px) => Math.min(1, Math.max(0, (px - L) / (R - L)));
  const fromY = (py) => Math.min(1.6, Math.max(-0.6, lo + ((CB - py) / (CB - T)) * (hi - lo)));

  /** Fit the vertical range to the curve and its handles. While dragging it only grows, so the view never jumps under the pointer. */
  function fit(b) {
    let mn = 0, mx = 1;
    if (b !== 'hold') {
      mn = Math.min(mn, b[1], b[3]); mx = Math.max(mx, b[1], b[3]);
      for (let i = 0; i <= 40; i++) { const y = bezier(b, i / 40); mn = Math.min(mn, y); mx = Math.max(mx, y); }
    }
    const pad = 0.07 * (mx - mn);
    const nlo = mn - pad, nhi = mx + pad;
    if (dragging >= 0) { lo = Math.min(lo, nlo); hi = Math.max(hi, nhi); } else { lo = nlo; hi = nhi; }
  }

  function target() {
    const tl = store.doc.timeline;
    if (mode === 'speed') return { kind: 'speed', ease: tl.speed ?? 'linear', label: `whole shot · ${tl.duration}s` };
    const ks = keys();
    if (ks.length < 2) return null;
    let i = ks.findIndex((k) => k.id === store.state.key);
    if (i < 0 || i === ks.length - 1) i = sampleCamera(tl, store.state.time)?.segment ?? 0;
    i = Math.min(i, ks.length - 2);
    return { kind: 'segment', key: ks[i], next: ks[i + 1], ease: ks[i].ease, label: `${ks[i].id} → ${ks[i + 1].id} · ${(ks[i + 1].t - ks[i].t).toFixed(2)}s` };
  }

  function commit(ease) {
    const tg = target();
    if (!tg) return;
    if (tg.kind === 'speed') store.op({ op: 'timeline', speed: ease }, 'speed curve').catch(() => {});
    else { store.set({ key: tg.key.id }); updateKey({ ease }); }
  }

  const curvePath = (b) => {
    ctx.beginPath();
    if (b === 'hold') { ctx.moveTo(toX(0), toY(0)); ctx.lineTo(toX(1), toY(0)); ctx.lineTo(toX(1), toY(1)); return; }
    for (let i = 0; i <= 100; i++) { const u = i / 100; const y = bezier(b, u); i ? ctx.lineTo(toX(u), toY(y)) : ctx.moveTo(toX(u), toY(y)); }
  };

  function draw() {
    const tg = target();
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
    const line = css('--cc-line'), strong = css('--cc-line-strong'), text = css('--cc-text'), accent = css('--cc-accent'), faint = css('--cc-text-faint');
    const surface = css('--cc-surface-solid');
    const font = (px) => `${px}px ${css('--cc-font') || 'sans-serif'}`;
    const b = tg ? (live || resolveEase(tg.ease)) : 'hold';
    fit(tg ? b : 'linear');

    // grid: quarter-time verticals through curve and strip, the 0 and 1 progress lines
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    for (const x of [0.25, 0.5, 0.75]) { ctx.beginPath(); ctx.moveTo(toX(x) + 0.5, T); ctx.lineTo(toX(x) + 0.5, SB); ctx.stroke(); }
    ctx.strokeStyle = strong;
    for (const y of [0, 1]) { ctx.beginPath(); ctx.moveTo(L, Math.round(toY(y)) + 0.5); ctx.lineTo(R, Math.round(toY(y)) + 0.5); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(L, SB + 0.5); ctx.lineTo(R, SB + 0.5); ctx.stroke();
    // axis hints
    ctx.fillStyle = faint; ctx.font = font(9);
    ctx.save(); ctx.translate(L - 6, (toY(0) + toY(1)) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText('progress →', 0, 0); ctx.restore();
    if (!tg) { ctx.fillStyle = faint; ctx.font = font(11); ctx.textAlign = 'center'; ctx.fillText('Add a second key to ease between them', W / 2, (T + CB) / 2); ctx.textAlign = 'left'; return; }

    // linear reference, then the hovered preset as a ghost
    ctx.strokeStyle = line; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(toX(0), toY(0)); ctx.lineTo(toX(1), toY(1)); ctx.stroke();
    if (preview && !live && easeName(tg.ease) !== preview) {
      ctx.strokeStyle = accent; ctx.globalAlpha = 0.55; ctx.lineWidth = 1.5; curvePath(resolveEase(preview)); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 1;
    }
    ctx.setLineDash([]);

    // curve
    ctx.strokeStyle = text; ctx.lineWidth = 2; ctx.lineJoin = 'round'; curvePath(b); ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = text;
    for (const [x, y] of [[0, 0], [1, 1]]) { ctx.beginPath(); ctx.arc(toX(x), toY(y), 2.5, 0, Math.PI * 2); ctx.fill(); }

    // speed strip: how fast the camera moves along its path, 1× = linear
    ctx.fillStyle = faint; ctx.font = font(9); ctx.textAlign = 'right'; ctx.fillText('time →', R, ST + 8); ctx.textAlign = 'left';
    if (b === 'hold') { ctx.fillText('speed · holds, then cuts', L + 3, ST + 8); }
    else {
      const N = 80, sp = [];
      let mx = 0, mn = 0;
      for (let i = 0; i <= N; i++) { const s = bezierSpeed(b, i / N); sp.push(s); mx = Math.max(mx, s); mn = Math.min(mn, s); }
      const top = Math.max(2, mx), sy = (s) => SB - ((s - mn) / (top - mn)) * (SB - ST - 10);
      ctx.beginPath(); ctx.moveTo(toX(0), sy(0));
      sp.forEach((s, i) => ctx.lineTo(toX(i / N), sy(s)));
      ctx.lineTo(toX(1), sy(0)); ctx.closePath();
      ctx.fillStyle = accent; ctx.globalAlpha = 0.14; ctx.fill(); ctx.globalAlpha = 1;
      ctx.beginPath(); sp.forEach((s, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, toX(i / N), sy(s)));
      ctx.strokeStyle = accent; ctx.lineWidth = 1.25; ctx.stroke(); ctx.lineWidth = 1;
      ctx.strokeStyle = line; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(L, sy(1)); ctx.lineTo(R, sy(1)); ctx.stroke(); ctx.setLineDash([]);
      if (mn < 0) { ctx.strokeStyle = strong; ctx.beginPath(); ctx.moveTo(L, sy(0) + 0.5); ctx.lineTo(R, sy(0) + 0.5); ctx.stroke(); }
      ctx.fillStyle = faint; ctx.fillText(`speed · peak ${mx.toFixed(1)}×${mn < -0.01 ? ' · backs up' : ''}`, L + 3, ST + 8);
    }
    if (b === 'hold') return;

    // handles: arm from its end point, hollow when idle, filled when hovered or dragged
    [[b[0], b[1], 0, 0], [b[2], b[3], 1, 1]].forEach(([x, y, ax, ay], i) => {
      const on = i === hover || i === dragging;
      ctx.strokeStyle = accent; ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(toX(ax), toY(ay)); ctx.lineTo(toX(x), toY(y)); ctx.stroke();
      ctx.beginPath(); ctx.arc(toX(x), toY(y), on ? 6 : 5, 0, Math.PI * 2);
      ctx.fillStyle = on ? accent : surface; ctx.fill(); ctx.lineWidth = 2; ctx.stroke(); ctx.lineWidth = 1;
    });
  }

  const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const nearest = (e) => {
    const tg = target(); if (!tg) return -1;
    const b = resolveEase(tg.ease); if (b === 'hold') return -1;
    const [x, y] = pos(e);
    const d0 = Math.hypot(toX(b[0]) - x, toY(b[1]) - y), d1 = Math.hypot(toX(b[2]) - x, toY(b[3]) - y);
    return Math.min(d0, d1) > 16 ? -1 : d0 < d1 ? 0 : 1;
  };
  cv.addEventListener('pointerdown', (e) => {
    const i = nearest(e); if (i < 0) return;
    dragging = i; live = [...resolveEase(target().ease)];
    cv.setPointerCapture(e.pointerId);
    cv.style.cursor = 'grabbing';
    draw();
  });
  cv.addEventListener('pointermove', (e) => {
    if (dragging < 0) {
      const i = nearest(e);
      if (i !== hover) { hover = i; cv.style.cursor = i < 0 ? '' : 'grab'; draw(); }
      return;
    }
    const [x, y] = pos(e);
    live[dragging * 2] = +fromX(x).toFixed(3);
    live[dragging * 2 + 1] = +fromY(y).toFixed(3);
    showName();
    draw();
  });
  cv.addEventListener('pointerleave', () => { if (dragging < 0 && hover >= 0) { hover = -1; draw(); } });
  cv.addEventListener('pointerup', (e) => {
    if (dragging < 0) return;
    dragging = -1;
    const b = live; live = null;
    showName();
    hover = nearest(e); cv.style.cursor = hover < 0 ? '' : 'grab';
    const name = easeName(b);
    commit(name !== 'custom' ? name : b);
  });

  const showName = () => {
    const tg = target();
    const current = tg ? easeName(tg.ease) : '';
    // while dragging: the bezier numbers; hovering a preset: its name; otherwise the current ease
    nameEl.classList.toggle('cc-mono', !!live);
    nameEl.textContent = live ? live.map((n) => n.toFixed(2)).join(', ') : preview && preview !== current ? preview : current;
    nameEl.classList.toggle('is-preview', !live && !!preview && preview !== current);
  };

  function refresh() {
    if (!api.open || !store.doc) return;
    const tg = target();
    title.textContent = tg ? tg.label : '';
    const current = tg ? easeName(tg.ease) : '';
    // a grid of curve thumbnails; the last cell holds a custom curve when there is one
    const names = Object.keys(EASES).filter((k) => !(mode === 'speed' && k === 'hold'));
    // rebuilding removes the hovered button without a pointerleave, so drop its preview
    changed(presets, [mode, current, current === 'custom' ? tg.ease : null], () => (preview = null, presets.replaceChildren(
      ...names.map((k) => h('button.cc-btn.cc-btn--ghost.curve-preset', {
        type: 'button', title: k, 'aria-label': k, html: easeSvg(k, 18),
        class: k === current ? 'is-active' : null,
        onClick: () => commit(k),
        onPointerenter: () => { preview = k; showName(); draw(); },
        onPointerleave: () => { if (preview === k) { preview = null; showName(); draw(); } },
      })),
      h('button.cc-btn.cc-btn--ghost.curve-preset', {
        type: 'button', title: current === 'custom' ? 'custom (drag the handles)' : 'Drag the handles for a custom curve',
        'aria-label': 'custom', disabled: current !== 'custom',
        class: current === 'custom' ? 'is-active' : 'is-empty',
        html: current === 'custom' ? easeSvg(tg.ease, 18) : '<svg viewBox="0 0 16 16" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"><path d="M2 13C7 13 9 3 14 3"/></svg>',
      }))));
    showName();
    // only worth offering when another segment would change
    const ks = keys(), cur = tg?.ease;
    const others = tg?.kind === 'segment' ? ks.slice(0, -1).filter((k) => k !== tg.key && !isCut(k)) : [];
    allBtn.hidden = !others.length || isCut(tg.key);
    allBtn.disabled = others.every((k) => JSON.stringify(k.ease) === JSON.stringify(cur));
    help.textContent = mode === 'speed'
      ? 'Slow motion and fast forward for the camera and everything in the shot. Its length stays the same.'
      : 'Drag the orange handles. The strip shows how fast the camera moves.';
    draw();
  }

  function toggle(on, m) {
    if (on === undefined) on = !(api.open && (!m || m === mode));
    if (m) { mode = m; tabs.value = m; }
    api.open = on; pop.hidden = !on; onToggle?.(on, mode);
    if (!on) preview = null;
    if (on && anchor) {
      const a = mode === 'speed' ? null : anchor();
      const r = a && a.offsetParent ? a.getBoundingClientRect() : null;
      pop.style.left = r ? `${Math.max(12, Math.min(innerWidth - 304, r.left - 40))}px` : '';
    }
    refresh();
  }
  return api;
}


/** Popover from the "5.00 s · 24 fps" chip: duration (with retime), frame rate (any value, presets), export size, shot speed. */
function mountShotSettings(root, { anchor, keys, openSpeed }) {
  let retime = true;
  try { retime = localStorage.getItem(RETIME_KEY) !== '0'; } catch {}
  const tlOp = (patch, label) => store.op({ op: 'timeline', ...patch }, label).catch(() => {});
  const setDur = (v) => tlOp({ duration: +v.toFixed(3), retime: retime || undefined }, 'shot length');

  const durNum = number({ step: 0.1, min: 0.1, max: 600, precision: 2, width: 44, title: 'Shot length in seconds. Drag to scrub, Shift for big steps.', onChange: setDur });
  const less = button({ icon: 'minus', kind: 'ghost', title: 'Half a second shorter', onClick: () => setDur(Math.max(0.1, store.doc.timeline.duration - 0.5)) });
  const more = button({ icon: 'plus', kind: 'ghost', title: 'Half a second longer', onClick: () => setDur(Math.min(600, store.doc.timeline.duration + 0.5)) });
  const durField = h('div.cc-affix.shot-dur', {}, less, durNum, h('span.cc-affix__unit', {}, 's'), more);
  const retimeSw = onOff({ value: retime, title: 'Scale key times with the shot length so the move keeps its timing', onChange: (v) => { retime = v; try { localStorage.setItem(RETIME_KEY, v ? '1' : '0'); } catch {} } });

  const fpsNum = number({ step: 1, min: 1, max: 120, precision: 3, width: 48, title: 'Frames per second. Any value, e.g. 23.976.', onChange: (v) => tlOp({ fps: v }, 'frame rate') });

  const sizeSel = select({ options: [], title: 'Export size', onChange: (v) => { const [width, height] = v.split('x').map(Number); store.op({ op: 'meta', width, height }, 'export size').catch(() => {}); } });
  const speedBtn = h('button.cc-field.tl-ease', { type: 'button', title: 'Playback speed: slow motion and fast forward for the whole shot', onClick: () => openSpeed() });
  const foot = h('div.cc-label.cc-mono.shot-foot');

  const p = panel({ title: 'Shot', collapsible: false, actions: [button({ icon: 'close', kind: 'ghost', title: 'Close (Esc)', onClick: () => toggle(false) })] });
  p.classList.add('shot-pop');
  p.hidden = true;
  const rowEl = (label, ...c) => h('div.cc-row', {}, h('span.cc-label', {}, label), ...c);
  p.body.append(
    rowEl('Duration', durField),
    h('div.cc-row.shot-sub', {}, retimeSw, h('span.shot-sub-text', { onClick: () => retimeSw.click() }, 'Stretch keys to fit')),
    rowEl('Frame rate', affix(fpsNum, 'fps')),
    rowEl('Size', sizeSel),
    rowEl('Playback', speedBtn),
    h('div.cc-divider.cc-divider--h'),
    foot,
  );
  document.body.append(p); // outside #timeline so it can sit above the chat panel

  const api = { open: false, toggle, refresh };
  function place() {
    const r = anchor.getBoundingClientRect();
    p.style.right = `${Math.max(12, innerWidth - r.right)}px`;
  }
  function toggle(on = p.hidden) {
    api.open = on; p.hidden = !on;
    anchor.classList.toggle('is-open', on);
    anchor.replaceChild(icon(on ? 'chevronUp' : 'chevronDown'), anchor.lastElementChild);
    if (on) { place(); refresh(); }
  }
  function refresh() {
    if (!api.open || !store.doc) return;
    const tl = store.doc.timeline, m = store.doc.meta;
    durNum.set(tl.duration);
    fpsNum.set(tl.fps);
    const cur = `${m.width}x${m.height}`;
    const opts = SIZES.map(([w, hh]) => `${w}x${hh}`);
    if (!opts.includes(cur)) opts.unshift(cur);
    const ratio = (w, hh) => { const g = (a, b) => (b ? g(b, a % b) : a); const d = g(w, hh); return `${w / d}:${hh / d}`; };
    changed(sizeSel, [opts, cur], () => {
      sizeSel.replaceChildren(...opts.map((o) => { const [w, hh] = o.split('x').map(Number); return h('option', { value: o }, `${w} × ${hh} · ${ratio(w, hh)}`); }));
      sizeSel.value = cur;
    });
    const sp = tl.speed ?? 'linear';
    changed(speedBtn, sp, () => {
      speedBtn.innerHTML = easeSvg(sp);
      speedBtn.append(h('span', {}, easeName(sp)), icon('chevronDown'));
    });
    const n = keys().length;
    foot.textContent = `${Math.round(tl.duration * tl.fps)} frames · ${n} key${n === 1 ? '' : 's'}`;
  }
  addEventListener('pointerdown', (e) => { if (api.open && !p.contains(e.target) && !anchor.contains(e.target)) toggle(false); }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && api.open) { e.stopPropagation(); toggle(false); } }, true);
  addEventListener('resize', () => { if (api.open) place(); });
  return api;
}
