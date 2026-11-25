// A chat video shown beside the shot frame. "Beside shot" under a video in the chat puts it in the viewport
// to the right of the shot frame, the two the same height and centred together (viewport.layout places
// both), hides the chat and switches to shot view. The video follows the timeline: play, pause and scrub
// move it with the playhead. A render of the whole timeline lines up with every shot in order; a video as
// long as the active shot alone (a single-shot export) lines up with that shot. Muted, as the timeline's
// audio track already plays. The × closes it and brings the chat back.

import { h, button } from './ui/kit.js';
import { store } from './store.js';
import { shotList } from '/core/doc.js';

export function mountBeside(stage) {
  const video = h('video', { muted: true, playsInline: true, preload: 'auto' });
  video.muted = true;
  const close = button({ icon: 'close', kind: 'ghost', title: 'Close video and show the chat', onClick: () => hide() });
  close.classList.add('beside-close');
  close.setAttribute('aria-label', 'Close video and show the chat');
  const label = h('div.beside-label');
  const el = h('div.beside', { hidden: true }, video, close, label);
  stage.append(el);

  /** Show a video beside the shot. Reads its size first so the layout can pair it with the frame. */
  let pending = null; // the url being loaded: the latest pick wins over one still loading
  function show({ url, name }) {
    if (store.state.beside?.url === url && !pending) { store.set({ view: 'shot', chat: false }); return; }
    if (pending === url) return;
    pending = url;
    video.src = url;
    label.textContent = name || '';
    video.onloadedmetadata = () => {
      if (pending !== url) return;
      pending = null;
      const aspect = video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 9 / 16;
      store.set({ beside: { url, name, aspect }, view: 'shot', chat: false });
      sync(true);
    };
    video.onerror = () => { if (pending !== url) return; pending = null; store.emit('error', `couldn't load ${name || 'the video'}`); };
    video.load();
  }
  function hide() {
    pending = null;
    if (!store.state.beside) return;
    video.pause();
    video.removeAttribute('src'); video.load();
    store.set({ beside: null, chat: true });
  }

  // Where the playhead is, in seconds of the video.
  function videoTime() {
    const doc = store.doc, t = store.state.time;
    if (!doc) return t;
    const shots = shotList(doc);
    const total = shots.reduce((a, s) => a + s.timeline.duration, 0);
    const dur = video.duration || 0;
    // a single-shot export: as long as the active shot and not as long as the whole timeline
    if (shots.length > 1 && Math.abs(dur - doc.timeline.duration) < 0.1 && Math.abs(dur - total) >= 0.1) return t;
    let before = 0;
    for (const s of shots) { if (s.active) break; before += s.timeline.duration; }
    return before + t;
  }
  function sync(force = false) {
    if (!store.state.beside || !video.duration) return;
    const want = Math.min(videoTime(), Math.max(0, video.duration - 0.001));
    if (store.state.playing && want < video.duration - 0.05) {
      // playing: let the video run, and pull it back only when it drifts
      if (video.paused) { video.currentTime = want; video.play().catch(() => {}); }
      else if (force || Math.abs(video.currentTime - want) > 0.15) video.currentTime = want;
    } else {
      if (!video.paused) video.pause();
      if (force || Math.abs(video.currentTime - want) > 1e-3) video.currentTime = want;
    }
  }
  store.on('state', (c) => {
    if (c.time || c.playing) sync(!!c.playing);
  });
  store.on('doc', () => sync(true));

  return {
    el, show, hide,
    /** viewport.layout() calls this with the video's rect, or null to hide it. */
    place(r) {
      el.hidden = !r;
      if (r) Object.assign(el.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    },
  };
}
