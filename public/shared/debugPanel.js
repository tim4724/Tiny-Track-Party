// Debug settings panel — a faint wrench button (bottom-left) that opens a card
// for editing this page's URL query params interactively. Controls are
// prefilled from the current location; Apply rebuilds the query string and
// reloads the page so every param takes effect through its normal boot path.
// Params the schema doesn't list (e.g. ?claim=) are preserved untouched.
//
// Each page passes its own schema (the display knows its tracks/cars, the
// controller its scenarios), an array of:
//   { section: 'Title' }                          — a group heading, or
//   { key, label, hint?, type, options?, min?, max? } — a param:
//     type 'flag'   → checkbox, serialized as key=1 / absent
//     type 'int'    → number input, absent when blank, clamped to min/max
//     type 'select' → dropdown with a "default" blank choice, absent when blank
//     options: [{ value, label }] for selects
//     bare: a select value to show when the param is present with NO value
//           (e.g. ?solo ≡ ?solo=0) — without it a bare param would prefill as
//           the blank "default" choice and Apply would silently drop it
//
// Dev aid only: no game state is read or written — the page's own param
// parsing stays the single source of truth.

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

export function initDebugPanel(schema, { title = 'Debug' } = {}) {
  // Stylesheet, versioned like the page's own links (the __ guard covers a raw
  // template token if the server ever serves the HTML unprocessed).
  if (!document.getElementById('dbg-style')) {
    const v = document.querySelector('meta[name="app-version"]')?.content || '';
    const link = el('link');
    link.id = 'dbg-style';
    link.rel = 'stylesheet';
    link.href = '/shared/debugPanel.css' + (v && !v.startsWith('__') ? '?v=' + encodeURIComponent(v) : '');
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) setOpen(false);
  });

  document.body.appendChild(fab);
  document.body.appendChild(panel);
}
