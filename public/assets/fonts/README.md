# Fonts

Self-hosted so the strict CSP can keep `font-src 'self'` (no Google Fonts CDN).

| File                    | Family  | Type           | License            |
| ----------------------- | ------- | -------------- | ------------------ |
| `fredoka-variable.woff2`| Fredoka | variable (wght)| SIL OFL 1.1        |
| `nunito-variable.woff2` | Nunito  | variable (wght)| SIL OFL 1.1        |

Both are variable fonts — a single file covers the whole weight axis, so the
`@font-face` rules in `/shared/theme.css` declare a `font-weight` range and the
browser interpolates. Only the **latin** subset (U+0000–00FF + common
punctuation) is shipped, which is all the UI needs.

- **Fredoka** — display / headings / numerals. `--font-display`.
- **Nunito** — body / labels. `--font-body`.

The SIL Open Font License (`OFL-Fredoka.txt`, `OFL-Nunito.txt`) permits
bundling and self-hosting for commercial use; the license must travel with the
font files, which is why those texts live here.

To refresh: re-download the latin `woff2` from Google Fonts (variable axis) and
overwrite the files above — the `@font-face` rules don't change.
