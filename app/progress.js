// A progress card in the chat (canvas progress): one long job the agent is waiting on, such as a render.
// It shows the stage, a bar and the time since it started, and keeps counting between the agent's updates.
// The agent updates the same card in place; when the job ends the card settles into one line.

import { h, icon } from './ui/kit.js';

const clock = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const about = (secs) => (secs < 90 ? `${Math.round(secs)} s` : `${Math.round(secs / 60)} min`);
const QUIET = 30 * 60000; // no word from the agent for this long: say so rather than spin for ever

/** progressCard(message) → { el, id, update(message) }. message.progress: { id, title, state, steps?, step?, pct?, note?, eta?, startedAt, endedAt? } */
export function progressCard(m) {
  let p = m.progress, updatedAt = p.updatedAt || m.at;
  const el = h('div.chat-prog', { 'data-progress': p.id, role: 'status' });
  const mark = h('span.chat-prog-mark');
  const title = h('span.chat-prog-title');
  const time = h('span.chat-prog-time');
  const fill = h('span.chat-prog-fill');
  const bar = h('div.chat-prog-bar', {}, fill);
  const line = h('div.chat-prog-line');
  // A high detail review card also lists its passes: each inspection sheet and what the agent found on it.
  const passes = h('div.chat-prog-passes');
  el.append(h('div.chat-prog-head', {}, mark, title, time), bar, line, passes);
  let timer = null;

  // How far along: a percentage if the agent has one, else the stage it is on, else unknown.
  function fraction() {
    if (p.pct != null) return p.pct / 100;
    if (p.steps?.length && p.step) return (p.step - 0.5) / p.steps.length;
    return null;
  }
  function tick() {
    const running = p.state === 'running';
    const now = running ? Date.now() : (p.endedAt || updatedAt);
    time.textContent = clock(now - p.startedAt);
    if (!running) return;
    const quiet = Date.now() - updatedAt > QUIET;
    el.classList.toggle('is-quiet', quiet);
    const bits = [];
    if (p.steps?.length && p.step) bits.push(`${p.steps[p.step - 1]} · ${p.step} of ${p.steps.length}`);
    if (p.note) bits.push(p.note);
    if (quiet) bits.push('no update for a while');
    else if (p.eta) { const left = p.eta - (Date.now() - p.startedAt) / 1000; bits.push(left > 20 ? `about ${about(left)} left` : `usually takes about ${about(p.eta)}`); }
    line.textContent = bits.join(' · ');
    line.hidden = !bits.length;
  }
  function render() {
    el.dataset.state = p.state;
    title.textContent = p.title;
    // A finished card carries no mark: the settled line says it. Only a failure keeps one.
    mark.hidden = p.state === 'done';
    mark.replaceChildren(...(p.state === 'running' ? [h('span.cc-spin')] : p.state === 'failed' ? [icon('close')] : []));
    if (p.auto) el.dataset.auto = ''; // a "still working" note: once answered it is just that note, dimmed
    const f = fraction();
    bar.hidden = p.state !== 'running';
    bar.classList.toggle('is-unknown', f == null);
    fill.style.width = f == null ? '' : `${Math.round(Math.max(0.02, Math.min(1, f)) * 100)}%`;
    if (p.state !== 'running') {
      line.textContent = p.note || (p.state === 'done' ? 'Done' : 'Stopped');
      line.hidden = false;
      el.classList.remove('is-quiet');
    }
    renderPasses();
    clearInterval(timer); timer = null;
    tick();
    if (p.state === 'running') timer = setInterval(() => { if (!el.isConnected) { clearInterval(timer); timer = null; } else tick(); }, 1000);
  }
  function renderPasses() {
    const list = p.review?.passes || [];
    passes.hidden = !list.length;
    // The latest pass shows its whole sheet; earlier ones shrink to a thumbnail beside what they found.
    passes.replaceChildren(...list.map((x, i) => {
      const latest = i === list.length - 1;
      const sheet = x.url ? h(`a.chat-pass-sheet${latest ? '' : '.is-small'}`, { href: x.url, target: '_blank', rel: 'noopener', title: 'Open the inspection sheet' }, h('img', { src: x.url, alt: `Inspection sheet, pass ${x.n}`, loading: 'lazy' })) : null;
      const found = x.found?.length ? h('ul.chat-pass-found', {}, ...x.found.map((f) => h('li', {}, f))) : null;
      return h(`div.chat-pass${latest ? '' : '.is-old'}`, {},
        h('div.chat-pass-head', {}, `Pass ${x.n}`, h('span', {}, x.found == null ? 'looking…' : x.found.length ? `${x.found.length} to fix` : 'no problems')),
        latest ? [sheet, found] : h('div.chat-pass-row', {}, sheet, found));
    }));
  }
  render();
  return { el, id: p.id, update(next) { p = next.progress; updatedAt = p.updatedAt || next.at; render(); } };
}
