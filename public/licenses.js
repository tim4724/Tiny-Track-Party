// The licenses page. It renders shared/credits.js and decides nothing: the
// sections and their order are data, so the only thing here is DOM. Songs
// arrive from the live music catalogue, never a list typed on this page.
// Relative, not root-absolute: this module resolves its own imports against
// where IT was loaded from, so the page survives being hosted under a prefix
// (see shared/assetUrl.js and tests/asset-urls.test.js).
import { RACE_MUSIC } from './display/audio/musicCatalogue.js';
import { creditsFor, licenseInfo } from './shared/credits.js';

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

function link(href, cls, text) {
  const a = el('a', cls, text);
  a.href = href;
  // Everything linked from here is either an upstream project or a license
  // text — both leave the game, so both open away from it.
  if (/^https?:/.test(href)) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
}

// The license chip is the entry's ONE link to its terms, and it points at the
// most specific text there is: where the license requires its own text to ship
// with the build, that is our served copy, which carries the real copyright
// line. Otherwise it is the canonical text of the license itself. (This used to
// be two links, a generic one plus a "notice", which left CC0 works showing a
// notice or not depending only on whether a file happened to exist.)
function licenseChip(entry) {
  return link(entry.notice ?? licenseInfo(entry.license).url, 'pill entry__license', entry.license);
}

// One credited work as a row: what it is and who made it on the left, what it
// costs us on the right.
function entryRow(entry) {
  const row = el('li', 'entry');
  // Title + author share one shrinkable box so a long name wraps INSIDE it and
  // the license chip stays on the row rather than being pushed under it.
  const what = el('span', 'entry__what');
  what.appendChild(link(entry.url, 'entry__title', entry.title));
  what.appendChild(el('span', 'entry__author', entry.author));
  row.appendChild(what);
  row.appendChild(licenseChip(entry));
  return row;
}

function sectionCard({ section, entries }) {
  const card = el('section', 'card sec');

  // The badge straddles the card's top edge like a label slapped on it.
  card.appendChild(el('h2', 'sec__badge', section));

  // Every section renders the same way, music included: one row per work, its
  // own author and license on each. The music used to collapse to chips under a
  // single shared credit line, which was shorter but made one section read
  // unlike the rest.
  const list = el('ul', 'entries');
  for (const entry of entries) list.appendChild(entryRow(entry));
  card.appendChild(list);
  return card;
}

const sections = document.getElementById('sections');
for (const group of creditsFor(RACE_MUSIC)) sections.appendChild(sectionCard(group));
