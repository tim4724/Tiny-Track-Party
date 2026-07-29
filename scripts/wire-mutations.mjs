// The mutations the two wire-suite gate-the-gate harnesses apply — DATA, so a
// test can read them without running a build.
//
// scripts/wire-mutate.mjs patches C++ and rebuilds the wasm (minutes, needs
// emsdk); scripts/wire-mutate-js.mjs patches the JS producers (seconds). Both are
// run on demand, never on a PR, which is exactly how four of these quietly went
// dead: `_publishLobby` composed the LOBBY_UPDATE snapshot in JS until the room
// policy moved to C++, and after that the four `display/*` anchors matched
// nothing. The harness reported ANCHOR MISSING — to nobody, because nobody ran
// it. tests/wire-mutation-anchors.test.js now reads THIS file on every `npm test`
// and fails when an anchor or an expected test title stops existing.
//
// Each entry:
//   name    stable id (`--only=` matches a substring)
//   kind    the class of defect being simulated
//   file    repo-relative path to patch
//   find    the anchor — must appear EXACTLY ONCE in that file
//   replace what it becomes
//   expect  a substring of the title of the test that MUST go red

// ---------------------------------------------------------------------------
// C++ — one per class the brief calls out: a renamed field, a reformatted
// number, an optional flipped to null, a reordered array — plus one that
// silently misroutes, because that is the failure mode a shell port actually
// produces.
//
// The ROSTER block covers the same classes on the object the phone actually
// lives off. Every field of LOBBY_UPDATE is now authored on the FAR side of the
// boundary — RoomFlow serialises the player rows, ttp::session::lobby_snapshot
// composes the object around them — so the retype/drop/reorder classes live
// here, and what is left on the JS side is the shell's own plumbing (below).
// They were all silent until tests/wire-compat.test.js stopped deep-equalling a
// literal it had just written and started driving the real producer.
// ---------------------------------------------------------------------------
export const CPP_MUTATIONS = [
  {
    // A key typo at the seam. copyKey copies by NAME, so misnaming a field does
    // not error — it produces a snapshot with the key ABSENT, and every phone
    // loses the host (no Start button, anywhere).
    //
    // THIS PAIR AND THE NEXT USED TO BE JS MUTATIONS against Net.js, back when
    // the shell gathered the roster and the host and handed them to the session
    // model. ttp_net_lobby_frame gathers them in C++ now, so the hazard moved
    // here with the code — same break, same assertion, one language over. A
    // mutation whose anchor vanishes is a DEAD gate, which is what
    // tests/wire-mutation-anchors.test.js exists to notice.
    name: 'display/lobby-key-typo',
    kind: 'misname a key the frame builder hands the session model',
    file: 'native/runtime/ttp_net.cc',
    find: '  input.set("hostPeerIndex", ttp_room_host_value(roomHandle));',
    replace: '  input.set("host", ttp_room_host_value(roomHandle));',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    // The frame builder chooses the ORDER the seats are published in (the model
    // projects the rows it is handed, one for one). Reversing the roster also
    // misaligns the parallel inRace array, which is exactly what a caller that
    // sorted its own list would do.
    name: 'display/roster-order-reversed',
    kind: 'publish the roster in a different order than the model was told',
    file: 'native/runtime/ttp_net.cc',
    find: '  input.set("roster", ttp_room_roster_value(roomHandle));',
    // Spelled with only what the file already includes, so the mutation is a
    // one-line swap and never drags a header in behind it.
    replace: '  { Value r_ = ttp_room_roster_value(roomHandle), rev_ = Value::Arr();\n'
      + '    for (size_t i_ = r_.arr.size(); i_ > 0; i_--) rev_.push(r_.arr[i_ - 1]);\n'
      + '    input.set("roster", rev_); }',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'framing/renamed-field',
    kind: 'change a field name in the C++ encoder',
    file: 'native/libttp-party/ttp/relay_framing.cc',
    find: '  m.set("to", to);',
    replace: '  m.set("peer", to);',
    expect: 'every C++ outbound encoder produces bytes the relay accepts',
  },
  {
    name: 'serializer/number-formatting',
    kind: "change a number's formatting",
    file: 'native/libttp-json/ttp/jsonnum.cc',
    find: 'EcmaScriptConverter().ToShortest(v, &sb);',
    replace: 'EcmaScriptConverter().ToPrecision(v, 17, &sb);',
    expect: 'numbers cross the boundary in shortest form, both directions',
  },
  {
    name: 'fastlane/ack-t-null',
    kind: 'flip an optional to null',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: '  ack.set("t", t ? *t : Value());',
    replace: '  ack.set("t", t ? *t : Value::Null());',
    expect: 'the ack DROPS `t` when the data packet had none',
  },
  {
    name: 'fastlane/ring-order-reversed',
    kind: 'reorder an array',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: '  for (const RingEntry& e : ring_) h.push(e.ev);',
    replace: '  for (auto it = ring_.rbegin(); it != ring_.rend(); ++it) h.push(it->ev);',
    // Found the suite's one blind spot on the first run: the display is the
    // RECEIVING side, so nothing exercised the C++ Link as a SENDER and reversing
    // this turned no test red. tests/wire-fastlane.test.js now decodes a
    // C++-authored packet with the real JS receiver, which is what bites here.
    expect: 'a C++-SENT packet decodes in the real JS receiver',
  },
  {
    name: 'framing/misrouted-from',
    kind: 'read the wrong key on the inbound path',
    file: 'native/libttp-party/ttp/relay_framing.cc',
    find: '    if (const Value* f = field(frame, "from")) in.from = *f;',
    replace: '    if (const Value* f = field(frame, "index")) in.from = *f;',
    expect: 'the kit and C++ classify every prod relay frame identically',
  },

  // ---- the roster the phone reads (LOBBY_UPDATE) ---------------------------
  {
    name: 'roomflow/peerindex-stringified',
    kind: 'retype a roster field the phone matches with ===',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '  o.set("peerIndex", peerIndex.toValue());',
    replace: '  o.set("peerIndex", Value::Str(peerIndex.key()));',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/connected-bool-to-num',
    kind: 'retype a boolean to 0/1',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '  o.set("connected", Value::Bool(connected));',
    replace: '  o.set("connected", Value::Num(connected ? 1 : 0));',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/roster-fields-dropped',
    kind: 'drop the opaque game fields (name/colorIndex/carIndex/ready)',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '  for (const auto& kv : fields) o.set(kv.first, kv.second);',
    replace: '  for (const auto& kv : fields) { (void)kv; }',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/roster-order-reversed',
    kind: 'reorder the roster',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: `Value RoomFlow::listValue() const {
  std::vector<const Player*> arr;
  for (const auto& p : players_) arr.push_back(&p);
  std::stable_sort(arr.begin(), arr.end(),
                   [](const Player* a, const Player* b) { return a->joinedAt < b->joinedAt; });`,
    replace: `Value RoomFlow::listValue() const {
  std::vector<const Player*> arr;
  for (const auto& p : players_) arr.push_back(&p);
  std::stable_sort(arr.begin(), arr.end(),
                   [](const Player* a, const Player* b) { return a->joinedAt > b->joinedAt; });`,
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    // The snapshot is COMPOSED in C++ now (ttp::session::lobby_snapshot), so the
    // object the phone parses is authored on the far side of the boundary. The
    // roster row is the part the phone matches ITSELF against — it reads
    // `inRace` by name to decide whether to drop into the race or wait for the
    // next one — and nothing but this suite has both parsers in one process.
    name: 'session/roster-row-loses-inrace',
    kind: 'drop a field the phone routes itself on',
    file: 'native/libttp-party/ttp/session.cc',
    find: '    row.set("inRace", Value::Bool(truthy(flag)));',
    replace: '    (void) flag;',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    // The chooser payload the dumb controller renders from. `cars` rides every
    // snapshot on purpose (the late-joiner picker needs it mid-race); dropping
    // it leaves a phone that joined during a race with nothing to pick from.
    name: 'session/chooser-cars-go-lobby-only',
    file: 'native/libttp-party/ttp/session.cc',
    kind: 'gate an always-present chooser key on the lobby',
    find: '  copyKey(out, chooser, "cars");',
    replace: '  if (lobby) copyKey(out, chooser, "cars");',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'roomflow/state-renamed',
    kind: 'rename a phase string the phone compares against protocol.js',
    file: 'native/libttp-party/ttp/room_flow.cc',
    find: '    case State::RESULTS: return "results";',
    replace: '    case State::RESULTS: return "result";',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'serializer/tab-unescaped',
    kind: 'emit a raw control byte instead of an escape',
    file: 'native/libttp-json/ttp/canonical.cc',
    find: "      case '\\t': o += \"\\\\t\"; break;",
    replace: "      case '\\t': o += '\\t'; break;",
    // Invalid JSON on the wire: prod answers "Invalid JSON" and the roster stops
    // updating for the whole room. Only reachable through a NAME, which is the one
    // free-text field on the wire.
    expect: 'a control character in a name stays ESCAPED all the way round',
  },
  {
    name: 'fastlane/ack-prune-off-by-one',
    kind: 'move a boundary in the sender-side ring prune',
    file: 'native/libttp-party/ttp/fastlane.cc',
    find: '    while (keepLen > 0 && ring_[keepLen - 1].es <= pa->num) keepLen--;',
    replace: '    while (keepLen > 0 && ring_[keepLen - 1].es <  pa->num) keepLen--;',
    // The other half of "nothing in the browser runs the C++ Link as a SENDER":
    // the ring-order fix covered sendDataPacket, handleAck was still uncovered, so
    // a fully-acked event resent forever at 20 Hz with the suite green.
    expect: 'a C++ SENDER stops resending what the ack covered',
  },
];

// ---------------------------------------------------------------------------
// JS — the producers the suite watches that need no build at all:
//
//   * public/display/Net.js   — the SHELL's half of the retained snapshot. It no
//                               longer composes the object (C++ does), so what is
//                               mutable here is the plumbing a tvOS/Android shell
//                               will have a sibling of: which keys it hands the
//                               model, in what order it hands the roster, whether
//                               a mutation republishes at all, and whether the
//                               chooser catalogue was ever plugged in.
//   * public/shared/names.js  — the name cap both pages apply.
//   * tests/wire-compat/relay.js — the model's OWN enforcement. A model that
//                               quietly stops enforcing prod's rules is the exact
//                               defect that makes testing against the permissive
//                               E2E stub worthless, so it gets mutated too.
//
// Every one of these was invisible to the suite until it stopped deep-equalling a
// snapshot literal it had just written: renaming the roster key on the real
// producer left both suites green (34/34), and so did applying the code-point fix
// the emoji test claimed it would announce.
//
// One mutation is deliberately a FIX rather than a break (names/codepoint-slice):
// a gate that says "when this lands, this assertion is what tells you it worked"
// has to go red when it lands. Red here means the claim is true.
// ---------------------------------------------------------------------------
export const JS_MUTATIONS = [
  {
    // Storing a mutation without republishing it. The room is RIGHT and every
    // phone is stale — the classic shell bug, and invisible to anything that
    // only reads the display's own state.
    name: 'display/ready-not-republished',
    kind: 'store a roster change without publishing it',
    file: 'public/display/Net.js',
    find: '          p.ready = !!data.ready;\n          this._announce();',
    replace: '          p.ready = !!data.ready;',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    // The chooser catalogue is the shell's to plug in, and it is handed over ONCE
    // at construction. Never plugging it in leaves every phone's car picker empty
    // — including the late joiner's, mid-race, which is the case the always-on
    // `cars` key exists for.
    name: 'display/chooser-cars-unplugged',
    kind: 'fail to plumb a chooser catalogue into the model',
    file: 'public/display/Net.js',
    find: '    this.carChooser = opts.carChooser || [];',
    replace: '    this.carChooser = [];',
    expect: 'the LOBBY_UPDATE the display AUTHORS survives the round trip',
  },
  {
    name: 'display/name-clamp-dropped',
    kind: 'stop re-clamping an untrusted HELLO name',
    file: 'public/display/Net.js',
    find: '        if (p && data.name) p.name = cleanName(data.name);',
    replace: '        if (p && data.name) p.name = String(data.name);',
    expect: 'an emoji name is the ONE place C++ loses data',
  },
  {
    name: 'names/codepoint-slice',
    kind: 'APPLY the code-point fix the emoji test promises to announce',
    file: 'public/shared/names.js',
    find: "  return (n == null ? '' : String(n)).trim().slice(0, NAME_MAX);",
    replace: "  return [...(n == null ? '' : String(n)).trim()].slice(0, NAME_MAX).join('');",
    expect: 'an emoji name is the ONE place C++ loses data',
  },
  {
    name: 'relay/host-only-guard-deleted',
    kind: 'make the model stop enforcing host-only set_state',
    file: 'tests/wire-compat/relay.js',
    find: "    if (index !== 0) return this._send(ws, { type: 'error', message: 'Only the host can set state' });\n",
    replace: '',
    expect: 'only slot 0 may publish the room snapshot',
  },
  {
    name: 'relay/state-cap-noop',
    kind: 'make the model stop enforcing the 16 KiB cap',
    file: 'tests/wire-compat/relay.js',
    find: "      return this._send(ws, { type: 'error', message: 'State too large' });",
    replace: '      void 0;',
    expect: 'a snapshot over the cap is REFUSED',
  },
  {
    name: 'relay/idle-drops-quiet-sockets',
    kind: 'restore the WRONG model of idleTimeout (drop application-idle sockets)',
    file: 'tests/wire-compat/relay.js',
    find: '      if (idleMs >= PING_AFTER_MS) {\n        ws._pingsSent++;\n        if (ws.autoPong) ws._idleSweeps = 0;\n      }',
    replace: '      if (idleMs >= PING_AFTER_MS) { ws._pingsSent++; }',
    expect: 'prod does NOT drop an application-idle socket',
  },
];
