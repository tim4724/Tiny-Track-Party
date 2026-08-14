// assetUrl — resolve a root-absolute site path ('/assets/…', '/display/…')
// against THIS MODULE's location instead of the document. On the web the two
// are identical (this file serves from /shared/, one level below the site
// root), so nothing about the served game changes.
//
// The difference appears wherever the tree is hosted under a PREFIX: the
// document root is then not the game root, and every document-absolute path
// 404s at once. Module-relative is the only anchor that holds in both layouts.
// Since the web and the preview deploys all serve from a domain root, no
// surface anyone tests by hand shows the breakage — so the rule is held by a
// gate instead, tests/asset-urls.test.js.
//
// Dependency-free and import.meta-based, so Node imports (the cue table, the
// music catalogue) resolve to file:// URLs and keep working.
export function assetUrl(path) {
  return new URL('..' + path, import.meta.url).href;
}
