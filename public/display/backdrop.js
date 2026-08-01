// The lobby backdrop: the sunny 2D diorama is the persistent base layer, and the
// 3D #scene sits over it shown/hidden BY OPACITY (.is-dim), not display, so it can
// crossfade straight in over the paper.
//
// Split out of main.js because this is a state machine, not a pair of helpers: a
// generation counter, two timers and a frozen still, all of which have to agree.
// While it lived inline its three pieces sat hundreds of lines apart and a
// deferred call from the boot path silently re-dimmed a scene the test harness had
// just revealed — a working render at opacity 0, which reads as a blank page.
//
// WHETHER the 3D should show is the CALLER's (it depends on the screen, the room
// state and the pick); this module only performs the reveal and the dissolve. The
// predicates arrive as functions because both are read AFTER an await or a frame,
// by which time the answer can have changed.
const el = (id) => document.getElementById(id);

// Mirrors the opacity transitions on #scene / #scene-snap in display.css.
const FADE_MS = 450;
let fadeTimer = null, snapTimer = null, fadeGen = 0;

// Reveal (or dim) the 3D scene. Visibility is by opacity now, not display.
export function setBackdrop3D(on) {
  const sc = el('scene');
  sc.classList.remove('hidden');
  sc.classList.toggle('is-dim', !on);
}

// Two transitions share this, picked by whether a track is already on screen:
//
//  • track → track (a track is showing): a TRUE crossfade between circuits. Freeze the
//    current track as a still over #scene (stage.snapshot), run `mid` to rebuild the live
//    canvas to the new track UNDERNEATH the still, then fade the still out so the new track
//    emerges through the old. It never dips through the diorama background.
//  • diorama → track (the very first pick — #scene still transparent): there's no outgoing
//    track to dissolve from, so reveal the just-built track over the diorama by fading
//    #scene's own opacity in.
//
// `mid` (swap track, rebuild demo cars, drop the frozen race field…) always runs under cover.
// `show3D()` decides whether the reveal actually un-dims; `stillValid()` is re-asked a frame
// later, before the rebuild, so a race starting under a lobby crossfade drops the still
// instead of rebuilding behind it.
export function crossfadeBackdrop(stage, mid, { show3D, stillValid }) {
  const sc = el('scene');
  if (!sc) { mid(); return; }
  const dio = el('lobby-diorama'); if (dio) dio.classList.remove('hidden'); // base for the first reveal
  // Clear any in-flight crossfade so rapid track-cycling can't stack stills / fade timers.
  // fadeGen invalidates any deferred build still queued from a superseded pick (see below).
  clearTimeout(fadeTimer); clearTimeout(snapTimer);
  const gen = ++fadeGen;
  const oldSnap = el('scene-snap'); if (oldSnap) oldSnap.remove();

  const buildThenFadeIn = () => {
    // try/finally so a throw in mid() can never leave the backdrop stuck transparent.
    try { mid(); }
    finally {
      sc.classList.remove('hidden');
      sc.classList.add('is-dim');           // hold the just-built track transparent for one frame…
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setBackdrop3D(show3D());             // …then fade it in over the diorama
      }));
    }
  };

  const visible = !sc.classList.contains('hidden') && !sc.classList.contains('is-dim');
  if (!visible) { buildThenFadeIn(); return; }   // first reveal → diorama → track

  // A track is on screen: dissolve it straight into the next one. The still is a frozen frame
  // of the OUTGOING track; the live #scene rebuilds to the new track behind it.
  const still = stage.snapshot();
  if (!still) {                                  // capture unavailable → fall back to the dip
    sc.classList.add('is-dim');
    fadeTimer = setTimeout(buildThenFadeIn, FADE_MS);
    return;
  }
  still.id = 'scene-snap';
  sc.appendChild(still);                         // sits over the live canvas, inside #scene's z-0 layer
  sc.classList.remove('is-dim');                 // the live track stays fully opaque beneath the still
  // Order matters: start the fade FIRST, rebuild the track a frame LATER. An opacity
  // transition runs on the compositor, so it keeps animating even while the main thread is
  // busy — whereas setTrack blocks the thread for tens of ms (and the orbit with it). By the
  // time the rebuild runs the compositor already owns the fade, so the hitch happens UNDER a
  // still that's visibly dissolving and the preview never appears to stop. (The very first
  // reveal masks the same block with the compositor-animated diorama; see buildThenFadeIn.)
  // Until the rebuild swaps it, the live layer is still the OUTGOING track — same as the
  // still on top, so the early fade shows no change. mid() reads the latest pick, and a fast
  // re-pick supersedes this whole chain via fadeGen.
  const dissolve = () => {
    if (gen !== fadeGen) return;
    still.classList.add('is-fading');            // hand the dissolve to the compositor
    snapTimer = setTimeout(() => { still.remove(); }, FADE_MS);
  };
  // The swap finishes LATER than the frame that starts it (asset provisioning +
  // buildScene), so the still stays opaque until mid()'s promise resolves —
  // dissolving on schedule would just uncover the OLD circuit and let the new
  // one pop in.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gen !== fadeGen) return;                 // superseded by a newer pick
    requestAnimationFrame(() => {                // rebuild a frame later, hidden behind the still
      if (gen !== fadeGen) return;               // a newer pick (or leaving the lobby) cancelled us
      if (!stillValid()) {                       // race started under us → drop the still
        clearTimeout(snapTimer); still.remove(); return;
      }
      Promise.resolve(mid()).then(dissolve, dissolve);
    });
  }));
}
