// CouchPad shell, §10: ask for landscape BEFORE the first paint, so the phone
// rotates while the launcher's own "Joining…" cover is still up and the player
// never sees the turn. A classic <head> script on purpose — an inline call dies
// on the CSP (script-src 'self'), and a module would run too late. The bridge
// object only exists inside the launcher, so a plain browser no-ops here; the
// whole page is landscape-only, so there is no moment we'd ask for portrait.
if (window.CouchPadHost && typeof window.CouchPadHost.setOrientation === 'function') {
  window.CouchPadHost.setOrientation('landscape');
}
