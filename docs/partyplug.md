# partyplug: a verbatim copy

`partyplug/` is a byte-identical copy of `partyplug/` in the reference game.
Nothing in it is edited here: a change to the kit is made upstream, landed
there, and copied back whole.

- **Upstream:** `partyplug/` in [tim4724/HexStacker-Party](https://github.com/tim4724/HexStacker-Party) (public; `main`)
- **Synced to:** `04f01c85`, tree `220a1e53e404db13d4669948d93a83e9c4d73c23`

The tree is upstream's own git tree id for the folder at that commit
(`git rev-parse <commit>:partyplug`). `tests/partyplug-copy.test.js` computes
the same id from the files on disk, so it passes only while the copy is exact:
a local edit, an added file and a missing one all fail it.

## What this game uses of it

Both apps load only `PartyConnection.js` and `PartyFastlane.js`, and those are
the only kit files `server/site.js` serves. The rest comes along so the folder
stays identical:

- `RoomFlow.*` is upstream's JS room state machine. Ours is C++
  (`native/libttp-party/ttp/room_flow.h`, adapter
  `public/display/NativeRoomFlow.js`) and differs on purpose: `room_flow.h` is
  its contract, not the kit's `.d.ts`.
- `AirConsoleAdapter.*` and `AirConsoleStorage.*` serve AirConsole, which no app
  here loads.
- The kit's own suite, `partyplug/tests/`, runs in `npm test` like ours.

`PartyConnection.js` and `PartyFastlane.js` are also corpus inputs
(`tests/codegen-freshness.test.js`), so a sync that changes what either does
means regenerating its corpus and matching `native/libttp-party/`.

## Is there a new upstream version?

```bash
gh api repos/tim4724/HexStacker-Party/compare/<commit>...main --jq '.files[].filename' | grep ^partyplug/
```

Empty output means we are current. `.github/workflows/partyplug-upstream.yml`
runs that weekly, reading the commit out of this file, and opens (then edits in
place) an issue when upstream has moved.

## Syncing

```bash
git -C <upstream> fetch origin
rm -rf partyplug && git -C <upstream> archive <commit> partyplug | tar -x
git -C <upstream> rev-parse <commit>:partyplug   # the tree id to record above
```

Record the commit and tree above in the same commit as the copy, then run
`npm test`.

## What would end the copying

The copy is exact, so the kit could now be consumed as a dependency (its own
repo, a submodule or a subtree) and this file and its test would go away. That
is a decision about both games, not a chore.
