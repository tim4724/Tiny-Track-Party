# Upstream provenance

`partyplug/` is a **manual copy-fork**. There is no submodule, no subtree and no
published package: files were copied out of the reference game and are copied
again on each sync.

- **Upstream:** `partyplug/` in [tim4724/HexStacker-Party](https://github.com/tim4724/HexStacker-Party) (public; `main`)
- **Last synced from:** `eaac4206` (2026-07-30)

That stamp is a real commit on upstream's `main`, which is the whole reason to
record it: it turns "has anything changed?" into a git question with a yes/no
answer, instead of a file comparison someone has to read.

A copy-fork drifts in two directions, and only one of them is visible from here:
upstream fixes a transport bug and we never hear about it, or someone edits a kit
file here and the next sync silently clobbers it. The ledger below is what makes
the second direction visible; `tests/partyplug-fork.test.js` enforces it.

## Is there a new upstream version?

Ask git, against the stamp. No clone needed — the repo is public:

```bash
gh api repos/tim4724/HexStacker-Party/compare/<stamp>...main --jq '.files[].filename' | grep ^partyplug/
```

Empty output means we are current, and that is the answer: upstream commits that
touch nothing under `partyplug/` are not our business. With a clone to hand, the
same question reads better as history:

```bash
git -C <upstream> fetch origin
git -C <upstream> log --oneline <stamp>..origin/main -- partyplug/   # what they did
git -C <upstream> diff <stamp>..origin/main -- partyplug/<file>      # the patch to apply
```

Both forms show **only upstream's** changes. That is what the stamp buys: our
local deltas can never appear in the output, so nothing has to be adjudicated
before you can see whether there is anything to take.

`.github/workflows/partyplug-upstream.yml` runs the first form weekly and reads
the stamp out of this file, so a sync that updates the ledger moves the poll's
baseline with it. When upstream has moved it **opens an issue** (and edits that
same issue on later runs, so a deferred sync is not a weekly ping); the run only
fails if it could not report at all. It is scheduled-only and gates no push.

## Syncing

Take the patch, then update this file's stamp and the changed file's hash in the
same commit, and re-run `npm test`. `PartyConnection.js` and `PartyFastlane.js`
are also corpus inputs (`tests/codegen-freshness.test.js`), so a real change to
either means regenerating its corpus and matching `native/libttp-party/`.

To check the stamp is still honest — that our tree really is upstream-plus-the-ledger:

```bash
diff -ru <upstream>/partyplug partyplug
```

Every hunk should be one the ledger already explains. A hunk that isn't means
someone edited a kit file without declaring it, which is what
`tests/partyplug-fork.test.js` exists to catch first.

## Ledger

Hashes are the first 16 hex of `shasum -a 256` over **our** copy, so an
undeclared local edit fails the test rather than reaching the next sync as an
unexplained diff hunk. Update the hash in the same commit as the edit.

| File | sha256 (ours) | Local delta |
| --- | --- | --- |
| `PartyConnection.js` | `a432dd641ccc449f` | comments only — the scalar-message note cites our `ttp_framing_classify` where upstream cites its Kotlin/Swift ports |
| `PartyConnection.d.ts` | `81ea8d52afffa564` | none |
| `PartyFastlane.js` | `ded18593c20e25d5` | exports `PartyFastlane.TICK_MS` so `scripts/gen-fastlane-corpus.mjs` stamps the real cadence instead of re-typing 50. Worth upstreaming |
| `PartyFastlane.d.ts` | `07caed7eda7145ad` | declares what the JS already does: `enqueue`'s `'p2p' \| 'dropped'` return, the `onAcked`/`maxRing` options, and `static TICK_MS`. Worth upstreaming |
| `RoomFlow.d.ts` | `1d749261479089d5` | kept as the interface the C++ port implements, though `RoomFlow.js` is not here |
| `tests/party-connection.test.js` | `7f8467c4673d2ed8` | comments only, same reason as `PartyConnection.js` |
| `tests/party-fastlane.test.js` | `bb048dd7e480c164` | none — but ours is a **superset** upstream lacks (loss+retransmit loopback suite, the `'p2p'` return assert). Never clobber it wholesale |

**Files deliberately absent** (do not copy them in on a sync):

- `RoomFlow.js` — the room state machine is C++ here (`native/libttp-party`,
  adapter `public/display/NativeRoomFlow.js`), with the frozen behavioural
  corpus `tests/fixtures/roomflow-corpus.jsonl` as its oracle.
- `AirConsoleAdapter.*`, `AirConsoleStorage.*`, `tests/airconsole-*.test.js` —
  that platform was dropped. `package.json` and `README.md` are adapted to match.

## What would actually end the drift

A ledger makes drift visible; it does not remove it. The fix is to publish the
kit as its own repo and have both games consume it as a dependency. That needs
the local deltas resolved upstream first (the `TICK_MS` export is generic and
belongs there; the RoomFlow and AirConsole removals are just "don't import it"),
so it is a decision, not a chore. Until then: sync deliberately, and declare
every local edit here.
