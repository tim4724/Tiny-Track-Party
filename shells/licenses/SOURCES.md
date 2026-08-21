# The licences a TV row opens when nothing obliged us to ship a text

Shared by both TV shells, and by neither the web nor any bundle's own
`Licenses/` directory — which is exactly why this directory exists rather than a
copy under each shell.

**A TELEVISION CANNOT FOLLOW A LINK.** On /licenses.html every licence chip is a
link to the entry's terms: the served notice where one is shipped, else the
canonical URL at creativecommons.org (`public/licenses.js`). A TV has no browser,
so a row under a licence that obliges no notice — CC-BY 4.0 for every song, CC0
1.0 for the models and sound effects — named its licence and gave the room no way
to read it. These two texts are what that link becomes on a TV.

They are NOT notices in the sense `credits.js` means, and nothing here weakens
that distinction: a notice is the copy that DISCHARGES a permissive licence, it
belongs to the work rather than to the licence, and `tests/credits.test.js`
still fails a notice-tier entry that ships none. These are the licence itself,
one copy per licence id, shown because a viewer may as well be able to read it.

| File | Copied from | Shown for |
|---|---|---|
| `CC-BY-4.0.txt` | <https://creativecommons.org/licenses/by/4.0/legalcode.txt> | every race song |
| `CC0-1.0.txt` | <https://creativecommons.org/publicdomain/zero/1.0/legalcode.txt> | the Kenney kits and the sound effects |

Verbatim, and hard-wrapped by Creative Commons at 75 columns, which is the pitch
both boards' monospace pages are laid out for. Nothing may reformat or truncate
one. `scripts/shell-credits.mjs` maps a licence id to its file and throws when an
entry would reach the board with no text at all.
