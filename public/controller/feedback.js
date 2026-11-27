// The feedback form: one question on a cup's last board ("How much fun was
// that?"), and behind it a frost layer with two more ratings, two free-text
// fields and the choice to attach this phone's race stats (raceStats.js).
//
// It only ever asks AFTER the cup, on the board that is already about to send
// everyone home, and never twice for the same cup. Nothing is sent until the
// player taps Send, and what is sent is exactly `payload()` below: no name, no
// room code. It goes to the feedback service all Paper Balloon games share
// (paperballoon.games, repo Couch-Games, api/feedback.php), which keeps the
// games themselves static. The privacy policy there names the kinds of data in
// this game's `data` block; a new kind belongs there too.
import { raceStats, sessionId, token } from './raceStats.js';
import { inShell } from './launcher.js';
const { ROOM_STATE } = window; // protocol.js is a classic script: the page's globals

const ENDPOINT = 'https://paperballoon.games/api/feedback';
const MAX_TEXT = 300;
const FACES = ['Not fun', 'Meh', 'Okay', 'Fun', 'Great fun'];
const MOUTHS = [
  '<path d="M-5 6.2 Q0 1.2 5 6.2" fill="none"/>',
  '<path d="M-4.6 5.2 Q0 3.2 4.6 5.2" fill="none"/>',
  '<path d="M-4.6 4.4 L4.6 4.4" fill="none"/>',
  '<path d="M-5 3 Q0 7.4 5 3" fill="none"/>',
  '<path d="M-5.6 2.4 Q0 10 5.6 2.4 Z" fill="currentColor"/>'
];
const PROMPTS = {
  liked: { label: 'What did you like?', hint: 'A track, a car, a moment…' },
  disliked: { label: 'What bugged you?', hint: 'What got in the way? No personal data please.' }
};

const el = (id) => document.getElementById(id);

let _buzz = () => {};
let _onToggle = () => {};
let ctx = null;       // the cup this form is about, set by syncFeedbackAsk
let sent = false;     // this cup's feedback went out
let field = 'liked';  // which text the typing pane edits
let answers = freshAnswers();

function freshAnswers() {
  return { fun: null, controls: null, bots: null, liked: '', disliked: '', stats: true };
}

function faceSvg(i) {
  return '<svg viewBox="-12 -12 24 24" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle r="10.2" fill="none"/><circle cx="-3.6" cy="-2.6" r="1.35" fill="currentColor" stroke="none"/>'
    + '<circle cx="3.6" cy="-2.6" r="1.35" fill="currentColor" stroke="none"/>' + MOUTHS[i] + '</svg>';
}

function buildFaces(box) {
  FACES.forEach((name, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fb-face';
    b.dataset.value = String(i + 1);
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-label', name);
    b.innerHTML = faceSvg(i);
    box.appendChild(b);
  });
}

export function initFeedback({ buzz, onToggle }) {
  _buzz = buzz;
  _onToggle = onToggle;
  buildFaces(el('result-ask-faces'));
  buildFaces(el('fb-faces'));

  // The board's faces answer the first question and open the rest.
  el('result-ask-faces').addEventListener('click', (e) => {
    const b = e.target.closest('.fb-face');
    if (!b) return;
    _buzz('tap');
    answers.fun = Number(b.dataset.value);
    openPane('form');
  });
  // Fun is the one answer every submission has: the form opens on it and it can
  // be changed but not cleared. The other two ratings are optional, so tapping
  // the picked one clears it.
  el('fb-form').addEventListener('click', (e) => {
    const opt = e.target.closest('[role="radio"]');
    if (opt) {
      _buzz('tap');
      const set = opt.parentElement.dataset.set;
      const value = set === 'fun' ? Number(opt.dataset.value) : opt.dataset.value;
      answers[set] = set !== 'fun' && answers[set] === value ? null : value;
      render();
      return;
    }
    const text = e.target.closest('.fb-field');
    if (text) { _buzz('tap'); field = text.dataset.field; openPane('typing'); }
  });
  const onTap = (id, fn) => el(id).addEventListener('click', () => { _buzz('tap'); fn(); });
  const toForm = () => openPane('form');
  onTap('fb-stats', () => { answers.stats = !answers.stats; render(); });
  onTap('fb-whats', () => openPane('sent'));
  onTap('fb-close', closeFeedback);
  onTap('fb-back', toForm);
  onTap('fb-done', toForm);
  // The keyboard's Enter wears a checkmark (enterkeyhint="done"), so it has to
  // BE Done: in a textarea it would otherwise start a new line. `beforeinput`
  // rather than keydown, because it names the line break itself: a phone
  // keyboard's keydown is anonymous, and an IME confirming a word is an Enter
  // too.
  const input = el('fb-input');
  input.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertLineBreak' && e.inputType !== 'insertParagraph') return;
    e.preventDefault();
    _buzz('tap');
    toForm();
  });
  input.addEventListener('input', (e) => {
    // A pasted or dropped line break still arrives. Only then is the value
    // rewritten, since assigning it throws the caret to the end.
    if (/[\r\n]/.test(e.target.value)) e.target.value = e.target.value.replace(/[\r\n]+/g, ' ');
    answers[field] = e.target.value.slice(0, MAX_TEXT);
    el('fb-count').textContent = `${answers[field].length} / ${MAX_TEXT}`;
  });
  el('fb-send').addEventListener('click', send);
}

// Called with every results board. The question shows on the board that ends
// the cup as soon as it lands, and only to a phone that had a car in it
// (`meId`'s row). It deliberately ignores `settled`: that gate keeps the cup
// STANDING off the phone, which the question never mentions. `cup` is what the
// form needs to know about it: { cupId, cupName, car }.
export function syncFeedbackAsk(board, roomState, meId, cup) {
  const s = board.series;
  const landed = !!(board.over && roomState === ROOM_STATE.RESULTS);
  const final = landed && (!s || s.final);
  const ask = final && (board.order || []).some((o) => o.playerId === meId && !o.joining);
  if (ask) ctx = cup;
  el('results').classList.toggle('results--ask', ask);
  el('result-ask').classList.toggle('hidden', !ask);
  el('result-ask-label').classList.toggle('hidden', sent);
  el('result-ask-faces').classList.toggle('hidden', sent);
  el('result-ask-done').classList.toggle('hidden', !sent);
  if (!ask) closeFeedback();
}

// Back in the lobby: the next cup is asked about afresh.
export function resetFeedback() {
  closeFeedback();
  sent = false;
  ctx = null;
  answers = freshAnswers();
  el('results').classList.remove('results--ask');
  el('result-ask').classList.add('hidden');
}

export const feedbackOpen = () => !el('feedback-overlay').classList.contains('hidden');

// True when there was something to close (the shell's back button asks).
export function closeFeedback() {
  if (!feedbackOpen()) return false;
  el('fb-input').blur();
  el('feedback-overlay').classList.add('hidden');
  _onToggle();
  return true;
}

// Exported for the gallery (TestHarness), which shows each pane by the same
// call the taps above make.
export function openPane(name) {
  for (const pane of ['form', 'typing', 'sent', 'thanks']) {
    el('fb-' + (pane === 'sent' ? 'whatsent' : pane)).classList.toggle('hidden', pane !== name);
  }
  const wasOpen = feedbackOpen();
  el('feedback-overlay').classList.remove('hidden');
  if (!wasOpen) _onToggle();
  render();
  const input = el('fb-input');
  if (name === 'typing') {
    el('fb-input-label').textContent = PROMPTS[field].label;
    input.placeholder = PROMPTS[field].hint;
    input.value = answers[field];
    el('fb-count').textContent = `${answers[field].length} / ${MAX_TEXT}`;
    // In the same tap that opened the pane, or iOS will not raise the keyboard.
    input.focus({ preventScroll: true });
  } else {
    input.blur();
  }
  if (name === 'sent') renderWhatsSent();
}

const hasAnswer = () => !!answers.fun;

// What was just played, in words that read: "Random" is a series name, not
// something you can say "the" in front of.
function formTitle() {
  if (!ctx || !ctx.cupName) return 'How was that race?';
  if (ctx.cupId === 'random') return 'How were those races?';
  return `How was the ${ctx.cupName}?`;
}

function render() {
  el('fb-title').textContent = formTitle();
  for (const group of el('fb-form').querySelectorAll('[data-set]')) {
    const value = answers[group.dataset.set];
    for (const opt of group.children) opt.setAttribute('aria-checked', String(String(value) === opt.dataset.value));
  }
  for (const f of ['liked', 'disliked']) {
    const out = el('fb-' + f);
    const text = answers[f].trim();
    out.textContent = text || PROMPTS[f].hint;
    out.classList.toggle('is-empty', !text);
  }
  el('fb-stats').setAttribute('aria-checked', String(answers.stats));
  el('fb-send').disabled = !hasAnswer();
  el('fb-error').textContent = '';
}

function device() {
  const ua = navigator.userAgent;
  const tv = new URLSearchParams(location.search).get('pbp');
  return {
    phone: /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : 'other',
    app: inShell,
    tv: ['web', 'tvos', 'androidtv'].includes(tv) ? tv : 'unknown'
  };
}

// No id for the room or the couch, on purpose: anything derived from the room
// code can be matched to the web server's log of who opened that room. Reports
// of the same race are matched by the race itself (raceStats.js noteRace).
function payload() {
  const meta = document.querySelector('meta[name="app-version"]');
  // The envelope every Paper Balloon game shares: fun, the game's own answers,
  // the two texts. `data` is ours alone; the service stores it without reading it.
  const p = { v: 1, game: 'tinytrack', build: (meta && meta.content) || 'dev' };
  if (answers.fun) p.fun = answers.fun;
  p.answers = {};
  for (const k of ['controls', 'bots']) if (answers[k]) p.answers[k] = answers[k];
  for (const k of ['liked', 'disliked']) if (answers[k].trim()) p[k] = answers[k].trim();
  const cup = { id: ctx.cupId || 'race' };
  if (ctx.cupName) cup.name = token(ctx.cupName);
  p.data = { cup };
  if (answers.stats) {
    p.data.stats = raceStats(device());
    const session = sessionId();
    if (session) p.session = session;
  }
  return p;
}

async function send() {
  if (!hasAnswer() || !ctx) return;
  _buzz('tap');
  const btn = el('fb-send');
  btn.disabled = true;
  try {
    // text/plain keeps this a "simple" cross-origin request: no preflight.
    const res = await fetch(ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(payload())
    });
    if (!res.ok) throw new Error(String(res.status));
  } catch (_) {
    btn.disabled = false;
    el('fb-error').textContent = 'Could not send. Please try again.';
    return;
  }
  markSent();
  openPane('thanks');
  setTimeout(() => { if (!el('fb-thanks').classList.contains('hidden')) closeFeedback(); }, 1800);
}

// This cup has had its say: the board's question gives way to a thank-you.
// Exported for the gallery, which cannot get here by sending.
export function markSent() {
  sent = true;
  el('result-ask-label').classList.add('hidden');
  el('result-ask-faces').classList.add('hidden');
  el('result-ask-done').classList.remove('hidden');
}

// Plain words for what the stats switch adds; the numbers stay in the payload.
function renderWhatsSent() {
  const st = raceStats(device());
  const d = st.device;
  const phone = (d.phone === 'ios' ? 'iPhone' : d.phone === 'android' ? 'Android phone' : 'Phone')
    + (d.app ? ' with the Paper Balloon app' : '');
  const tv = { web: 'TV in a browser', tvos: 'Apple TV', androidtv: 'Android TV' }[d.tv];
  const rows = [
    ['How you steered', st.steering.tilt === 1 ? 'By tilting' : st.steering.tilt === 0 ? 'With the buttons'
      : st.steering.tilt >= 0.5 ? 'Mostly by tilting' : 'Mostly with the buttons'],
    ['Your connection', `How fast and how stable it was, ${st.fastlane.result === 'open' ? 'on a direct link to the TV' : 'through the game server'}`],
    ['Your car', (ctx && ctx.car) || 'The car you drove'],
    ['Race results', 'Each race: which car finished where, and the winning time'],
    ['Your devices', tv ? `${phone}, ${tv}` : phone]
  ];
  const list = el('fb-sent-list');
  list.textContent = '';
  for (const [name, value] of rows) {
    const row = document.createElement('div');
    row.className = 'fb-stat';
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = name;
    dd.textContent = value;
    row.append(dt, dd);
    list.appendChild(row);
  }
  el('fb-sent-off').classList.toggle('hidden', answers.stats);
}
