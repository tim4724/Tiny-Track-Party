// Debug settings panel — a faint gear button (bottom-left, shown on activity)
// that opens a card for editing this page's URL query params interactively.
// Controls are prefilled from the current location; Apply rebuilds the query
// string and reloads the page so every param takes effect through its normal
// boot path.
// Params the schema doesn't list (e.g. ?claim=) are preserved untouched.
//
// Each page passes its own schema (the display knows its tracks/cars, the
// controller its scenarios), an array of:
//   { section: 'Title' }                          — a group heading, or
//   { key, label, hint?, type, options?, min?, max? } — a param:
//     type 'flag'   → checkbox, serialized as key=1 / absent
//     type 'int'    → number input, absent when blank, clamped to min/max
//     type 'select' → dropdown with a "default" blank choice, absent when blank
//     type 'range'  → slider with −/+ step buttons and a numeric readout;
//           value: default, min/max/step, optional format(n)→label, optional live(n) called on every drag (and
//           once at init with the prefilled value) so the control can tune a live
//           value with NO reload. Serialized only when it differs from `value`, so
//           the URL stays clean at the default and a reload still restores any set value.
//     options: [{ value, label }] for selects
//     bare: a select value to show when the param is present with NO value
//           (e.g. ?solo ≡ ?solo=0) — without it a bare param would prefill as
//           the blank "default" choice and Apply would silently drop it
//
// Mostly a dev aid over URL params (Apply reloads). The one exception is a
// 'range' field's live(n) callback, which pushes its value straight into the page
// at drag time — used for feel-tuning (e.g. the steering curve) without a reload.

import { assetUrl } from './assetUrl.js';

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const FAB_IDLE_MS = 2500;

export function initDebugPanel(schema, { title = 'Debug' } = {}) {
  // Stylesheet, versioned like the page's own links (the __ guard covers a raw
  // template token if the server ever serves the HTML unprocessed).
  if (!document.getElementById('dbg-style')) {
    const v = document.querySelector('meta[name="app-version"]')?.content || '';
    const link = el('link');
    link.id = 'dbg-style';
    link.rel = 'stylesheet';
    link.href = assetUrl('/shared/debugPanel.css') + (v && !v.startsWith('__') ? '?v=' + encodeURIComponent(v) : '');
    document.head.appendChild(link);
  }

  const current = new URLSearchParams(location.search);
  const fields = []; // { def, read(): string|null }

  // ---- panel ----
  const panel = el('div', 'dbg card');
  panel.hidden = true;

  const head = el('div', 'dbg__head');
  head.appendChild(el('span', 'pill', title + ' · query params'));
  const closeBtn = el('button', 'dbg__close', '×');
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close debug settings');
  head.appendChild(closeBtn);
  panel.appendChild(head);

  const body = el('div', 'dbg__body');
  panel.appendChild(body);

  for (const def of schema) {
    if (def.section) { body.appendChild(el('div', 'dbg__section pill', def.section)); continue; }

    const row = el('label', 'dbg__row');
    const text = el('span', 'dbg__label', def.label);
    if (def.hint) text.appendChild(el('small', 'dbg__hint', def.hint));
    row.appendChild(text);

    let read;
    if (def.type === 'flag') {
      const input = el('input', 'dbg__check');
      input.type = 'checkbox';
      input.checked = current.get(def.key) === '1';
      input.addEventListener('input', refreshPreview);
      row.appendChild(input);
      read = () => (input.checked ? '1' : null);
    } else if (def.type === 'select') {
      const select = el('select', 'field dbg__input');
      const blank = el('option', null, '—');
      blank.value = '';
      select.appendChild(blank);
      for (const o of def.options) {
        const opt = el('option', null, o.label);
        opt.value = o.value;
        select.appendChild(opt);
      }
      const raw = current.get(def.key);
      const cur = raw === '' && def.bare != null ? def.bare : raw;
      if (cur !== null && [...select.options].some((o) => o.value === cur)) select.value = cur;
      select.addEventListener('input', refreshPreview);
      row.appendChild(select);
      read = () => select.value || null;
    } else if (def.type === 'range') {
      const step = def.step || 1;
      const dec = (String(step).split('.')[1] || '').length; // decimals to match the step
      const fmt = (n) => n.toFixed(dec);
      const def0 = def.value != null ? def.value : (def.min || 0);
      const label = (n) => (def.format ? def.format(n) : fmt(n));
      const clamp = (n) => Math.max(def.min, Math.min(def.max, n));

      const raw = current.get(def.key);
      const val = clamp(raw != null && raw !== '' && Number.isFinite(parseFloat(raw)) ? parseFloat(raw) : def0);

      row.classList.add('dbg__row--range');
      const wrap = el('div', 'dbg__range');
      const input = el('input', 'dbg__slider');
      input.type = 'range';
      input.min = def.min; input.max = def.max; input.step = step;
      input.value = String(val);
      const out = el('output', 'dbg__readout', label(val));
      const changed = () => {
        const n = parseFloat(input.value);
        out.textContent = label(n);
        if (def.live) def.live(n);
        refreshPreview();
      };
      input.addEventListener('input', changed);
      // − / + nudge by one step. After the slider in the DOM so it stays the
      // label's first control (a click on the label text focuses it, never −);
      // CSS `order` puts − back on the left.
      const nudge = (dir, text) => {
        const b = el('button', 'dbg__nudge ' + (dir < 0 ? 'dbg__nudge--dec' : 'dbg__nudge--inc'), text);
        b.type = 'button';
        b.setAttribute('aria-label', (dir < 0 ? 'Decrease ' : 'Increase ') + def.label);
        b.addEventListener('click', () => {
          input.value = String(clamp(parseFloat((parseFloat(input.value) + dir * step).toFixed(dec))));
          changed();
        });
        return b;
      };
      wrap.appendChild(input);
      wrap.appendChild(nudge(-1, '−'));
      wrap.appendChild(nudge(1, '+'));
      wrap.appendChild(out);
      row.appendChild(wrap);
      // Push the prefilled value into the page once, so a value carried in by the
      // URL takes effect at boot without the user having to touch the slider.
      if (def.live) def.live(val);
      // Serialize only when off the default, so the URL stays clean at `value`.
      read = () => { const s = fmt(parseFloat(input.value)); return s === fmt(def0) ? null : s; };
    } else { // 'int'
      const input = el('input', 'field dbg__input');
      input.type = 'number';
      if (def.min != null) input.min = def.min;
      if (def.max != null) input.max = def.max;
      input.placeholder = '—';
      const cur = current.get(def.key);
      if (cur !== null && cur !== '') input.value = cur;
      input.addEventListener('input', refreshPreview);
      row.appendChild(input);
      read = () => {
        let n = parseInt(input.value, 10);
        if (!Number.isFinite(n)) return null;
        if (def.min != null) n = Math.max(def.min, n);
        if (def.max != null) n = Math.min(def.max, n);
        return String(n);
      };
    }
    fields.push({ def, read });
    body.appendChild(row);
  }

  // ---- footer: live URL preview + apply/reset ----
  const url = el('code', 'dbg__url');
  panel.appendChild(url);

  const foot = el('div', 'dbg__foot');
  const resetBtn = el('button', 'btn btn--ghost dbg__btn', 'Reset');
  resetBtn.type = 'button';
  const applyBtn = el('button', 'btn btn--brand dbg__btn', 'Apply');
  applyBtn.type = 'button';
  foot.appendChild(resetBtn);
  foot.appendChild(applyBtn);
  panel.appendChild(foot);

  // Rebuild the query string from the controls. Start from the live params so
  // anything outside the schema survives; schema keys are fully re-derived.
  function buildSearch(values) {
    const qs = new URLSearchParams(location.search);
    for (const f of fields) {
      qs.delete(f.def.key);
      const v = values ? values.get(f.def.key) : f.read();
      if (v != null) qs.set(f.def.key, v);
    }
    const s = qs.toString();
    return s ? '?' + s : '';
  }

  function refreshPreview() {
    url.textContent = location.pathname + (buildSearch() || ' (no params)');
  }

  function navigate(search) {
    location.href = location.pathname + search + location.hash;
  }

  applyBtn.addEventListener('click', () => navigate(buildSearch()));
  resetBtn.addEventListener('click', () => navigate(buildSearch(new Map())));

  // ---- toggle button ----
  const fab = el('button', 'dbg-fab', '⚙');
  fab.type = 'button';
  fab.setAttribute('aria-label', 'Debug settings');
  const setOpen = (open) => {
    panel.hidden = !open;
    fab.classList.toggle('is-open', open);
    if (open) refreshPreview();
  };
  fab.addEventListener('click', () => setOpen(panel.hidden));
  closeBtn.addEventListener('click', () => setOpen(false));

  // Hidden until the pointer moves, like the display's corner buttons: a parked
  // gear is litter on a TV picture, and in every capture of the page. Any
  // pointer or key activity shows it for a spell (.is-open holds it in the CSS).
  let idleTimer = 0;
  const reveal = () => {
    fab.classList.add('is-awake');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fab.classList.remove('is-awake'), FAB_IDLE_MS);
  };
  for (const ev of ['pointermove', 'pointerdown', 'keydown']) {
    window.addEventListener(ev, reveal, { passive: true });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });

  document.body.appendChild(fab);
  document.body.appendChild(panel);
}
