// Standing up the native stack, and the world handed to it once. Everything here
// runs ONCE, in this order, before the page renders anything — which is why it is
// its own file: the sequence is the contract (configure before read, world before
// any render), and inline it was a hundred lines of ceremony between the URL
// parsing and the game.
//
// The C++ stack is the ONLY engine: the sim, the cup-series layer above it, and
// the party layer's decisions (room state, relay framing, fastlane netcode). The
// JS twins were retired once every layer was conformance-proven and the whole E2E
// suite ran green on them. A failure here is FATAL rather than a silent downgrade
// — there is nothing left to fall back to.
// Still JS by design: rendering, HUD, and the transport I/O (WebSocket /
// RTCPeerConnection), which wasm cannot own without proxying through JS anyway.
import { loadBiomes } from '../shared/biomes.js';
import { TRACK_SCHEMATICS } from '../shared/trackSchematics.js';
import * as ui from './NativeUiModel.js';

// A track is an ID here, and nothing more. The geometry is built inside the
// engine — by the sim when a race begins (ttp_session_begin) and by the renderer
// when the scene is built (ttp_display_build) — from the SAME C++ TrackBuilder,
// on the same descriptor codegen'd into the wasm. The browser used to carry a
// second builder purely to feed the renderer and to draw these mini-maps; the
// mini-maps are baked ahead of time now (shared/trackSchematics.js, regenerated
// by `npm run gen:schematics`) and nothing on this page integrates a track.
//
// `entry` is what the rest of the display passes around as "the track": the
// catalogue row plus the lap count the session reads off it.
export function trackEntry(t, totalLaps) {
  return { ...t, trackId: t.id, totalLaps };
}

// Boot the native stack and hand back everything the page reads off it. The
// window globals (field sizes, car table, lap count) arrive as `world` rather
// than being read here, so this module has no opinion about where they live.
export async function bootEngine({ maxPlayers, fieldSize, carModels, carColors, carNames, carStatsRows, totalLaps }) {
  const sim = await import('./NativeRaceSession.js');
  // The audio DECISIONS are C++ too (ttp_audio.h). Only the device half — the
  // AudioContext, the cue palette, the song element — is still JS, and it decides
  // nothing.
  const audio = await import('./NativeAudio.js');
  // The RACE ORCHESTRATION is C++ too (ttp_race.h): the state machine that starts
  // a race, launches one, walks the countdown, ends it, chains a cup and returns
  // to the lobby. It answers in ORDERED EFFECT LISTS and main.js's `perform` walks
  // them — the order is the contract, so nothing there may reorder or skip.
  const flow = await import('./NativeRaceFlow.js');
  await Promise.all([sim.init(), audio.init(), ui.init(), flow.init()]);

  // The world the UI model resolves ids against, handed over ONCE. Authored data
  // — it changes when the game ships, not while it runs — so it is set here
  // rather than re-sent with every pick. Before ANY render (the gallery harness
  // grids seats off it too). The WORLD ITSELF is not passed: it is codegen'd into
  // the wasm, so this is the point where the page stops having an opinion about
  // which tracks exist.
  ui.configure({ maxPlayers, carCount: carModels.length });
  // ...and read straight back, because the SHELL still has to draw the picker and
  // name the tracks in the phones' chooser payload. `catalog` is CUPS order
  // flattened. cupName is derived here rather than carried: the model answers with
  // a cup ID per track, and the cup NAMES are one lookup away in the same answer.
  const { cups, catalog } = ui.catalogue();
  const nameOf = new Map(cups.map((c) => [c.id, c.name]));
  const trackList = catalog.map((t) => ({ ...t, cupName: nameOf.get(t.cup) || null }));
  const built = new Map(trackList.map((t) => [t.id, trackEntry(t, totalLaps)]));
  const trackCatalog = trackList.map((t) => ({
    id: t.id, name: t.name, cup: t.cup, cupName: t.cupName, cupDifficulty: t.cupDifficulty,
    svg: TRACK_SCHEMATICS[t.id]
  }));

  // The same once-at-boot handover for the orchestration layer's world. Two things
  // about it are worth knowing:
  //   * NO `personas` KEY, which is how the CPU roster has one source. An
  //     ABSENT key asks the layer for libttp-sim's own ttp::AI_PERSONALITIES
  //     (ttp_race.h says so), so the table never leaves C++ and all three
  //     shells resolve to it the same way. Reading it back out through
  //     ttp_race_personas_json and handing it in would reach the same seven
  //     names with a serialize/parse in the middle — do not re-add it.
  //     public/display/aiPersonas.js survives for the test surfaces that need
  //     the table synchronously; tests/display-abi.test.js pins it to the wasm's.
  //   * carStats rows cross OPAQUE — copied into a field entry and never read —
  //     which is what keeps CAR_STATS out of the decision layer.
  flow.configure({
    fieldSize, carCount: carModels.length, colorCount: carColors.length,
    aiPrefix: 'ai-', carStats: carStatsRows, cups
  });
  // The biome ABI off the same module: the ?biome= list, the music pool key and
  // the HUD boost chip's accent. The palette itself never leaves C++.
  const biomes = await loadBiomes();

  const [room, conn, lane, sess, schem] = await Promise.all([
    import('./NativeRoomFlow.js'),
    import('./NativePartyConnection.js'),
    import('./NativePartyFastlane.js'),
    // The SESSION POLICY: the room snapshot, the seat rules, the message guards,
    // the self-heartbeat, the seat claim. DisplayNet performs its answers.
    import('./NativeSessionModel.js'),
    // ...and the track-map codec the snapshot's chooser payload is packed with.
    import('./NativeSchematic.js')
  ]);
  // One shared wasm module backs all of these (nativeRuntime.js memoizes it).
  await Promise.all([room.init(), conn.init(), lane.init(), sess.init(), schem.init()]);

  // The reduced maps the phones' picker renders: the baked full-res schematic,
  // RDP-simplified and uint8-packed by the native codec so the whole catalogue
  // fits the relay's 16 KiB set_state cap.
  // A track with no baked schematic loses its mini-map and nothing else. The two
  // lists cannot disagree in a shipped build — trackList comes from the wasm's
  // codegen'd catalogue and the bake comes from the same shared/tracks.js, and
  // tests/ui-model.test.js plus native-artifact gate the pair — but they are two
  // artifacts now rather than one module, so a dev mid-rebuild can hold a wasm
  // the bake has not caught up with. That should cost a picture, not the page.
  const trackChooser = trackList.flatMap((t) => {
    const baked = TRACK_SCHEMATICS[t.id];
    if (!baked) {
      console.error(`[display] no baked schematic for "${t.id}" — run npm run gen:schematics`);
      return [];
    }
    return [{
      id: t.id, name: t.name, cup: t.cup, cupName: t.cupName, cupDifficulty: t.cupDifficulty,
      svg: schem.pack(baked.d)
    }];
  });

  // Car id/name/handling stats for the phones' chooser (images load by id from
  // the web host), and the livery hex palette so a phone's dots always match the
  // car the display paints. Both ride the retained room snapshot.
  const carChooser = carModels.map((id, i) => {
    const s = carStatsRows[i] || {};
    return { id, name: carNames[i] || id, stats: { accel: s.accel, vmax: s.vmax, turn: s.turn, mass: s.mass } };
  });

  // The cup list is NOT handed back: it was configured into both layers above,
  // and the page asks the model (or the catalogue rows' own cupName) when it
  // needs one. The test surfaces that want cups synchronously read
  // shared/tracks.js directly.
  return {
    sim, audio, flow, biomes,
    trackList, built, trackCatalog, trackChooser, carChooser,
    // The room state machine, relay framing and fastlane netcode all run on the
    // C++ party layer; DisplayNet has no JS fallback to choose from.
    party: {
      RoomFlowImpl: room.NativeRoomFlow,
      PartyConnectionImpl: conn.NativePartyConnection,
      // The fastlane subclasses the kit's class (which keeps the WebRTC handshake and
      // is a classic-script global), so the subclass is built here, not at module scope.
      FastlaneImpl: lane.makeNativePartyFastlane(window.PartyFastlane)
    }
  };
}

// The snapshot's `progress` chooser key: the couch's per-cup stars/locked,
// read off the catalogue the wasm stamps and slimmed to what a phone draws. A
// FUNCTION, not a value from bootEngine — it changes when a cup banks, and
// main.js recomposes it inside the persist-progression performer.
// Composition only: every number here was derived inside the engine.
export function progressChooser() {
  const cat = ui.catalogue();
  return {
    cups: cat.cups.map((c) => ({
      id: c.id, stars: c.stars, locked: c.locked,
      ...(c.locked ? { unlockDone: c.unlockDone, unlockNeed: c.unlockNeed } : {})
    }))
  };
}
