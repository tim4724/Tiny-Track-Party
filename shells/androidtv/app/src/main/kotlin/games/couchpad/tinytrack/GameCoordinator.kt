package games.couchpad.tinytrack

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import kotlin.random.Random

/**
 * The one object that owns the game on this platform: it boots the engine, wires
 * the four systems (display, net, audio, assets) to each other, and performs what
 * C++ decided.
 *
 * It is the Kotlin counterpart of `public/display/main.js`, minus everything that
 * file no longer decides. The screen rules, the seat grid, the readiness rule, the
 * race orchestration, the pause arbitration and the results board are all
 * `libttp-runtime`; what is left here is boot order, timers, and turning an answer
 * into a [GameState] property or an ABI call.
 *
 * **If you find yourself writing an `if` about the game in this file, check
 * `ttp_ui.h` first.** The rule is not stylistic: a rule written here is a rule the
 * web and tvOS shells have to find and reimplement, and one written in C++ is
 * covered by a corpus on four legs.
 *
 * The tvOS twin is four files (`GameCoordinator` plus `+Lobby`, `+Net`, `+Race`
 * extensions); Kotlin has no cross-file extension of private state, so this is
 * one class with the same four section markers.
 */
class GameCoordinator(
    context: Context,
    /** The 3D surface. Built by the Activity, because only it owns a view tree. */
    surfaceView: android.view.SurfaceView,
    baseUrl: String = GameProtocol.DEFAULT_BASE_URL,
) {

    companion object {
        private const val TAG = "ttp"

        /** `localStorage`'s key on the web (`main.js`'s LAST_TRACK_KEY). */
        private const val LAST_TRACK_KEY = "tinytrack_last_track"

        /** Where the couch's progression blob persists (localStorage's peer). */
        private const val PROGRESS_KEY = "ttpProgress"

        private const val PREFS = "tinytrack"
    }

    val state = GameState()

    // -- systems -------------------------------------------------------------

    val proto: GameProtocol
    val display: DisplayHost
    val net: PartyNet
    val audio: AudioDevice
    val assets: AssetStore

    /**
     * The CouchPad LAN room record (CONTRACT §8). Driven by [syncAdvertisement],
     * plus the direct withdraw in [release] — which may run without a [suspend]
     * before it, so it cannot go through the sync.
     */
    private val advertiser: RoomAdvertiser
    val lobbyDemo = LobbyDemo()
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val main = Handler(Looper.getMainLooper())

    private val performer: RaceFlowPerformer by lazy { RaceFlowPerformer(this) }

    // -- shell state the model threads but does not hold ---------------------

    /**
     * What each phone was last told its item was — a String, or JSONObject.NULL for
     * an explicitly-cleared slot. The model gates the push
     * (`ttp_ui_item_pushes_live_json`); this is the memory the gate reads, and
     * null-vs-absent is a real distinction there, not a style choice.
     */
    val lastItem = HashMap<EngineId, Any>()

    /** Which reconnect cards actually attached, so the diff has a previous. */
    private val shownReconnectIds = LinkedHashSet<EngineId>()

    var sceneCars: List<SceneCar> = emptyList()

    /** The claim URL each reconnecting seat's card shows. Composed in C++. */
    private val reconnectUrls = HashMap<EngineId, String>()

    var sessionHandle = 0
        private set
    var autoPaused = false
    var raceEnded = false

    /** Did the scene build a launch asked for land? The countdown gate's one
     *  shell-side fact — see [rebuildScene], which owns it. */
    private var sceneBuildOk = true

    /** The launch effects a scene build stands between (`ttp_race.h`'s countdown
     *  gate): the held-back `start-countdown` paired with the moment the walk
     *  ran, which is what the rule's backstop is measured from. */
    private var pendingCountdown: Pair<JSONArray, Double>? = null

    /**
     * True only inside the AI fast-forward burst. Read by the race-event dispatch,
     * which must not spawn visuals for a race that is being SKIPPED rather than
     * watched.
     */
    private var fastForwarding = false

    /**
     * Whether any CONTROL has actually reached a car this session, and whether the
     * first failure has been reported. Both reset with the session — see the
     * `ttp_process_input` answer at the CONTROL short-circuit.
     */
    private var inputProven = false
    private var inputReported = false

    /**
     * Whether the app is off screen with its party wound up. Guards [suspend] and
     * [resume] against running twice.
     */
    private var suspended = false

    /**
     * The circuit the next race builds and the current scene shows. Held here
     * rather than read back from the display, because the pick exists before a
     * scene does (the lobby names a track, then stages it).
     */
    var trackId = ""
        private set

    /** Laps per race — the manifest's TOTAL_LAPS, assigned at boot. */
    private var laps = 3

    private var resultsFailsafe: Runnable? = null
    private var intermissionTask: Runnable? = null
    private var intermissionTicker: Runnable? = null
    private var intermissionDeadline = 0.0

    init {
        assets = AssetStore(context.assets)
        proto = GameProtocol.load(baseUrl)
        display = DisplayHost(surfaceView)
        // The bake's disk tier. Constructed here because it needs a Context and
        // the display does not have one; it prunes the previous binary's blobs on
        // the way up, which is why it is built at boot rather than lazily on the
        // first build. Scenarios get none: a screenshot harness must photograph
        // what a build produces, not what a previous run left on disk.
        if (!Scenarios.active) display.bakes = BakeCache(context)
        net = PartyNet(proto, RelaySocket(), context)
        advertiser = RoomAdvertiser(context)
        audio = AudioDevice(context.assets, baseUrl)
        ItemIcon.attach(context.assets)
        CarThumb.attach(context.assets)
        // THE COVER, BEFORE THE FIRST COMPOSITION. Compose draws before `boot()`
        // runs — boot() needs a surface, which is a posted turn and then seconds
        // of engine away — so a cover raised by boot()'s own `show(LOBBY)` would
        // arrive long after the frames it is meant to hide.
        //
        // NAMED, not [refreshCover]. That reads `state.screen`, which is still the
        // model's root here — and WELCOME is exactly the board `coverFor` exempts,
        // so asking through it answers "none" and the cover never raises. The
        // board these frames actually show is the lobby (boot() goes straight
        // there). The answer is still the model's; only the question is ours.
        // tvOS asks the identical question in its own init, for the same reason.
        state.cover = TtpJson.str(Ttp.ttp_ui_cover(TtpJson.arg("lobby"), 0)) ?: "boot"
    }

    /** Post to the main looper — the `deferred` arm of `refresh-auto-pause`. */
    fun post(block: () -> Unit) { main.post(block) }

    /**
     * A `ttp_*` call that reported failure, with the ENGINE's reason.
     *
     * `ttp_last_error()` carries why the last instrumented call refused. Composing
     * a message here instead would be guessing: "configure failed" cannot say
     * whether the JSON was malformed or a field was missing, because this side was
     * never told. A TV has no console, so this goes to `lastError`, which logs.
     */
    private fun requireOK(ok: Boolean, what: String): Boolean {
        if (ok) return true
        val why = TtpJson.strOrEmpty(Ttp.ttp_last_error())
        state.fail(if (why.isEmpty()) "$what (the engine gave no reason)" else "$what: $why")
        return false
    }

    // -- boot ----------------------------------------------------------------

    /**
     * There is a display again. Idempotent, and called on EVERY surface create:
     * the first fire boots, every later one re-provisions the materials and
     * rebuilds the scene. [DisplayHost.onSurfaceReady] keeps the full
     * destroyed-surface story.
     */
    fun displayReady() {
        try {
            // BEFORE any build. `buildScene` reads the materials out of the asset
            // map as it goes, and one that arrives afterwards is a material for the
            // next scene.
            // The asset map is fresh and so is the renderer's bake — both mirrors
            // of it have to let go on the same beat.
            display.bakes?.forget()
            SceneStaging.materials(display, assets)
        } catch (e: Exception) {
            state.fail("materials: ${e.message}")
        }
        if (!booted) {
            booted = true
            boot()
        } else {
            rebuildScene()
        }
    }

    private var booted = false

    /**
     * The boot order is `ttp_race.h` / `ttp_ui.h`'s, not a preference. Configure
     * before you ask, and read the catalogue back rather than shipping a copy of
     * it: `ttp_ui_configure` with no `cups`/`catalog` installs the world this BUILD
     * ships, so the track names and the cup list come out of the engine that
     * already holds them.
     */
    fun boot() {
        // The manifest's, not a constant of ours: TOTAL_LAPS is a number two layers
        // share, and re-declaring it here is the drift the manifest rule stops.
        laps = proto.totalLaps

        // The two field sizes, and nothing else: passing no catalogue is what asks
        // for the shipped one.
        //
        // CHECKED, not discarded. On tvOS these ran as `_ = …` and a boot with a
        // malformed payload carried on into a game with no catalogue, no field
        // rules and no chooser — every symptom of which appears somewhere else.
        requireOK(
            Ttp.ttp_ui_configure(TtpJson.arg(JSONObject()
                .put("maxPlayers", proto.maxPlayers)
                .put("carCount", proto.carModels.size).toString())) != 0,
            "configuring the UI model")

        // The couch's progression record, BEFORE the catalogue is read: stars, the
        // Playroom lock and the unlock counts come out stamped on it. The shell
        // persists the blob and decides nothing about it — nothing stored loads a
        // fresh couch.
        Ttp.ttp_ui_progress_load(TtpJson.arg(prefs.getString(PROGRESS_KEY, null)), 0)
        val catalogue = TtpJson.obj(Ttp.ttp_ui_catalogue_json())

        // The seat card's thumbnail lookup table. From the manifest, held once.
        state.carModels = proto.carModels
        refreshCupShelf()

        // No `personas` key: absent asks for libttp-sim's own table (the single
        // source), so boot hands over nothing it read back.
        requireOK(
            Ttp.ttp_race_configure(TtpJson.arg(JSONObject()
                .put("fieldSize", proto.fieldSize)
                .put("carCount", proto.carModels.size)
                .put("colorCount", proto.carColors.size)
                .put("aiPrefix", "ai-")
                .put("carStats", proto.carStats)
                .put("cups", catalogue.optJSONArray("cups") ?: JSONArray())
                .toString())) != 0,
            "configuring the race layer")

        // The boot proof the web shell runs at load: every op the race walks can
        // emit has a performer arm (a race answer may also carry net-vocabulary
        // ops, which fall through to PartyNet's switch). A port that grew a new op
        // fails HERE instead of dropping a step mid-race.
        val ops = TtpJson.strings(Ttp.ttp_race_effect_ops_json())
        val unperformable = ops.filter { it !in RaceFlowPerformer.PERFORMABLE }
        if (unperformable.isNotEmpty()) {
            requireOK(false, "race effect ops with no performer: ${unperformable.joinToString(", ")}")
        }

        // The same proof over the NET vocabulary, which ttp_net.h asks for by name.
        val netOps = TtpJson.strings(Ttp.ttp_net_effect_ops_json())
        val netMissing = netOps.filter { it !in PartyNet.PERFORMABLE }
        if (netMissing.isNotEmpty()) {
            requireOK(false, "net effect ops with no performer: ${netMissing.joinToString(", ")}")
        }

        // The chooser payload the phones pick from. Set ONCE, and rides the LOBBY
        // snapshot only.
        //
        // ITS SHAPE IS A WIRE CONTRACT WITH THE PHONE, AND NOTHING HERE CHECKS IT.
        // `ttp_net_configure` takes this blob OPAQUELY, so a wrong key name travels
        // the whole way to the handset with no error at any layer. It is not in the
        // protocol manifest, no corpus covers it, and `abi_check` cannot see it
        // either. The ONLY reader is `public/controller/main.js`, and phones stay
        // on that JS controller on all three TV platforms, so its field names are
        // the specification:
        //
        //   cars   [{id, name, stats:{accel,vmax,turn,mass}}]
        //   tracks [{id, name, svg, cup, cupName, cupDifficulty}]
        //
        // The tvOS shell shipped `cars` as bare model-id STRINGS and spelled the
        // packed map `p` and the difficulty `level`, which is why a scanned phone
        // drew a car picker with no images, a track list with no maps and no cup
        // selector at all. Four symptoms, one shape.
        setChooser(catalogue)

        // THE CAMERA RIG FOR A SURFACE WITH NO CELLS, pushed once and never again:
        // with cells the renderer runs a chase cam per cell and this is ignored,
        // without them it is the whole picture. TTP_CAM_BBOX is the lobby's
        // perimeter sweep. The ABI's default is TTP_CAM_STILL — a shell that never
        // calls this gets the fitted iso view HELD MOTIONLESS, which looks exactly
        // like a correct render of a track and is why nobody spotted the tvOS lobby
        // preview was a photograph for the whole of the port.
        display.camera(2 /* TTP_CAM_BBOX */)

        audio.start()
        wireNet()

        // The room warms eagerly, and on THIS platform there is no board in front
        // of it: the app opens on the lobby. The web's welcome screen is not a
        // design element, it is a BROWSER WORKAROUND — the NEW GAME press is the
        // gesture that unlocks an AudioContext and enters fullscreen, neither of
        // which a TV app needs.
        //
        // THE SCREEN FIRST, then the preview. `previewLastCircuit` ends by asking
        // the attract demo to stand up, and the demo only runs while the lobby is
        // the current screen — previewing before `show` leaves the backdrop lifted
        // and NO scene ever builds behind it.
        show(GameState.Screen.LOBBY)
        previewLastCircuit()

        // THE RELAY IS THE ONE THING A SCENARIO MUST NOT HAVE, and this is the only
        // line that opens it. With a live room the 1 Hz liveness sweep sees four
        // scripted players who never ping and drops them one by one, so every race
        // photograph is of an emptying field — and seating a fake party is safe in
        // the first place ONLY because the liveness timer starts on a created/joined
        // walk that never runs. tvOS gates the same line for the same reason.
        if (Scenarios.active) Scenarios.standUp(this) else net.start()
    }

    /**
     * Put the paper diorama back: no circuit previewed, no scene on the surface.
     *
     * The boot state before [previewLastCircuit] runs, which no other road returns
     * to — and it is the only condition under which `PaperStage` is visible, so it is
     * the only way to photograph it. `release()` drops the scene a previous boot left
     * in the renderer, so the backdrop is what decides that picture rather than an
     * empty 3D view happening to be the same colour.
     */
    fun releaseScene() {
        trackId = ""
        display.release()
        refreshBackdrop()
    }

    /**
     * What the lobby shows before anybody has picked anything: the last party's
     * circuit, previewed under the attract race from the first frame.
     *
     * A PREVIEW, NEVER A PICK — the web's boot-time attract exactly: the room pick
     * stays null, so Start stays gated until the host's phone picks. The fallback
     * is the catalogue's first track (the easy cup's race 1).
     */
    private fun previewLastCircuit() {
        val catalog = TtpJson.obj(Ttp.ttp_ui_catalogue_json()).optJSONArray("catalog")
            ?: return
        val ids = (0 until catalog.length())
            .mapNotNull { catalog.optJSONObject(it)?.optString("id")?.ifEmpty { null } }
        if (ids.isEmpty()) return
        val last = prefs.getString(LAST_TRACK_KEY, null)
        setTrack(if (last != null && ids.contains(last)) last else ids[0])
        refreshLobby()
    }

    /**
     * The chooser's `progress` key, `boot.js progressChooser`'s shape: the per-cup
     * stars and locks the phones' picker draws. Composition only — every number was
     * derived inside the engine, off the stamped catalogue.
     */
    private fun progressChooser(): JSONObject {
        val cups = TtpJson.obj(Ttp.ttp_ui_catalogue_json()).optJSONArray("cups") ?: JSONArray()
        val out = JSONArray()
        for (i in 0 until cups.length()) {
            val c = cups.optJSONObject(i) ?: continue
            val e = JSONObject()
                .put("id", c.optString("id"))
                .put("stars", c.optInt("stars"))
                .put("locked", c.optBoolean("locked"))
            if (c.optBoolean("locked")) {
                e.put("unlockDone", c.optInt("unlockDone"))
                e.put("unlockNeed", c.optInt("unlockNeed"))
            }
            out.put(e)
        }
        return JSONObject().put("cups", out)
    }

    private fun setChooser(catalogue: JSONObject) {
        requireOK(
            Ttp.ttp_net_configure(TtpJson.arg(JSONObject()
                .put("cars", chooserCars())
                .put("colors", JSONArray(proto.carColors))
                .put("tracks", chooserTracks(catalogue))
                .put("progress", progressChooser())
                .toString())) != 0,
            "configuring the chooser payload")
    }

    /**
     * `persist-progression`: the walk banked a finished cup's stars; the shell
     * writes the blob it was handed and recomposes the snapshot's progress chooser,
     * so the phones' pickers carry the new stars when the party is back in the
     * lobby.
     */
    fun persistProgression(progress: Any?) {
        if (progress != null && progress !== JSONObject.NULL) {
            prefs.edit().putString(PROGRESS_KEY, progress.toString()).apply()
        }
        setChooser(TtpJson.obj(Ttp.ttp_ui_catalogue_json()))
        // AND THE COUCH'S OWN SHELF. Publishing the new stars to four phones while
        // the television still shows the old ones is the shape of bug the ledger
        // warns about: the reward arc ends up existing only where nobody is looking.
        refreshCupShelf()
        net.publishSnapshot()
    }

    /**
     * Re-read the cups shelf off the catalogue.
     *
     * TWO CALLERS AND NO MORE, because there are exactly two moments the record can
     * move: boot, and the `persist-progression` performer above. Riding a render
     * would re-read a table that changes once a cup, on every roster twitch.
     */
    private fun refreshCupShelf() {
        val cups = TtpJson.obj(Ttp.ttp_ui_catalogue_json()).optJSONArray("cups") ?: JSONArray()
        state.cups.clear()
        for (i in 0 until cups.length()) {
            cups.optJSONObject(i)?.let { GameState.CupRow.from(it)?.let(state.cups::add) }
        }
    }

    /**
     * The chooser's car list, as the phone's picker reads it: an id to load the
     * image by, a name, and the four handling stats the picker bars show.
     *
     * The images are NOT bundled here and must not be — the controller loads them
     * by id from the web host it was itself served from, so this list carries
     * identifiers, never pixels.
     */
    private fun chooserCars(): JSONArray {
        val out = JSONArray()
        for ((i, id) in proto.carModels.withIndex()) {
            val s = proto.carStats.optJSONObject(i) ?: JSONObject()
            out.put(JSONObject()
                .put("id", id)
                .put("name", proto.carNames.getOrElse(i) { id })
                // Exactly these four. The manifest's CAR_STATS also carries the
                // collision half-extents, which are the SIM's business and mean
                // nothing on a picker bar.
                .put("stats", JSONObject()
                    .put("accel", s.optDouble("accel", 0.0))
                    .put("vmax", s.optDouble("vmax", 0.0))
                    .put("turn", s.optDouble("turn", 0.0))
                    .put("mass", s.optDouble("mass", 0.0))))
        }
        return out
    }

    /**
     * The chooser's track list: what the phone draws a mini-map from, and what it
     * groups into cups.
     *
     * The pack is native (`ttp_schematic_pack` over `ttp_track_schematic_json`), so
     * this shell holds no projection — the web reads a prebaked table instead, but
     * both run the same C++ over the same track, so the maps agree.
     *
     * `cup` and `cupName` are load-bearing rather than decoration: the phone's mode
     * picker IS `trackCatalog.find((t) => t.cup)`, so a list without them offers
     * single races only and the cup selector never appears.
     */
    private fun chooserTracks(catalogue: JSONObject): JSONArray {
        val cupNames = HashMap<String, String>()
        val cups = catalogue.optJSONArray("cups") ?: JSONArray()
        for (i in 0 until cups.length()) {
            val c = cups.optJSONObject(i) ?: continue
            val id = c.optString("id")
            if (id.isNotEmpty()) cupNames[id] = TtpJson.optStr(c, "name") ?: id
        }
        // `catalog`, not `tracks`. That is the key `ttp_ui_configure` takes and
        // therefore the key the catalogue answers with — reading the wrong one
        // yields an empty list, and an empty list is a lobby with no track to race
        // and no error anywhere.
        val catalog = catalogue.optJSONArray("catalog") ?: JSONArray()
        val out = JSONArray()
        for (i in 0 until catalog.length()) {
            val t = catalog.optJSONObject(i) ?: continue
            val id = t.optString("id").ifEmpty { continue }
            // laps/seed only stamp the built track and no geometry depends on them;
            // 3/1 is the convention every other caller uses.
            val schematic = TtpJson.obj(Ttp.ttp_track_schematic_json(TtpJson.arg(id), 3, 1))
            // eps 0 asks for the TUNED default (0.35), chosen so straights
            // reproduce and corners do not clip. Passing a number overrides that
            // tuning — the tvOS shell sent 0.6 and drew coarser maps than the web
            // for no reason anyone had decided.
            val packed = TtpJson.str(
                Ttp.ttp_schematic_pack(TtpJson.arg(schematic.optString("d")), 0.0)) ?: ""
            val cup = TtpJson.optStr(t, "cup")
            out.put(JSONObject()
                .put("id", id)
                .put("name", TtpJson.optStr(t, "name") ?: id)
                .put("svg", packed)
                .put("cup", cup ?: JSONObject.NULL)
                .put("cupName", cup?.let { cupNames[it] } ?: JSONObject.NULL)
                .put("cupDifficulty", t.optInt("cupDifficulty")))
        }
        return out
    }

    // -- screens -------------------------------------------------------------

    fun show(screen: GameState.Screen) {
        if (state.screen == screen) return
        state.screen = screen
        refreshBackdrop()
        refreshCover()
    }

    /**
     * Paper, or the live 3D behind it.
     *
     * The rule is the web's `backdropShow3D()` and it has three clauses, not one:
     * never over the welcome board, and in the LOBBY only once a track is actually
     * picked. The tvOS shell had `screen != .welcome` alone, so a fresh lobby —
     * before anyone has chosen anything, which is the FIRST thing a viewer sees —
     * showed the 3D surface with no scene built on it. A black screen, where the
     * web shows the warm paper diorama.
     *
     * It has to be re-evaluated on a PICK as well as on a screen change, which is
     * why this is a function and not a line inside [show]: the track can arrive
     * from a phone long after the lobby is already up.
     */
    fun refreshBackdrop() {
        val racing = net.roomState != "lobby"
        state.sceneVisible =
            state.screen != GameState.Screen.WELCOME && (trackId.isNotEmpty() || racing)
    }

    /**
     * The boot cover, and a DIFFERENT rule from the backdrop above rather than a
     * line inside it. This one is a function of the screen and of whether a frame
     * has been painted, and of nothing else — a pick cannot move it, which is why
     * it needs two triggers where the backdrop needs three.
     * `tests/backdrop-rule.test.js` reads that function as ONE expression and
     * fails on anything left over, which is how mixing the two was caught.
     *
     * `hasPainted` and not `hasScene`: a built scene is not a drawn one, and
     * lifting on the build is the flash the cover exists to remove.
     *
     * SCENARIOS ARE EXEMPT, the same veto the web's `_isTestMode` applies to its
     * own. A screenshot scenario dresses a board and deliberately has no scene
     * behind it, so the honest answer for it is "boot" — and every reference shot
     * in the gallery would become a picture of the splash.
     */
    fun refreshCover() {
        val was = state.cover
        state.cover = if (Scenarios.active) "none" else TtpJson.str(
            Ttp.ttp_ui_cover(TtpJson.arg(state.screen.name.lowercase()),
                             if (display.hasPainted) 1 else 0)) ?: "none"
        if (state.cover != was) Log.i(TAG, "cover $was -> ${state.cover}")
    }

    /**
     * The landing after the room itself died under us. [PartyNet] has already
     * self-healed into a fresh room by the time this runs; the display's job is the
     * boot landing again: the lobby previewing the remembered circuit, so the
     * attract demo stands up exactly as a launch would stand it up.
     */
    private fun landOnFreshLobby() {
        show(GameState.Screen.LOBBY)
        previewLastCircuit()
    }

    // -- app lifecycle -------------------------------------------------------

    /**
     * The app left the screen, and on this platform that IS the party ending —
     * the web's `pagehide` rule. See [PartyNet.shutdown] for why it must be wired
     * to something; [MainActivity.onStop] is the hook.
     */
    fun suspend() {
        if (suspended) return
        suspended = true
        // THE LAN RECORD COMES DOWN FIRST. [net.shutdown] below closes the room,
        // and a record that outlives it costs a player a tap into a room that is
        // already gone.
        syncAdvertisement()
        // The mix goes with the frame loop: nothing will update a voice's level once
        // the Choreographer callback is gone, so a held one sounds forever.
        audio.silence()
        lobbyDemo.stop()
        net.shutdown()
        clearJoinTicket()
    }

    /**
     * The process is going away for good — [MainActivity.onDestroy]. [suspend]
     * ends a PARTY and runs on every trip to the home screen; this releases what
     * outlives one.
     */
    fun release() {
        advertiser.withdraw()
        net.release()
        audio.release()
    }

    /**
     * The ticket comes down the moment its room is dead, not when the next one
     * warms. `onRoomReady` only ever OVERWRITES the three fields, and a TV wakes an
     * app by showing its last frame first — so without this, every wake advertises
     * the closed room's QR for as long as the fresh create takes, and a phone that
     * scans it lands on a terminal "Room not found".
     */
    private fun clearJoinTicket() {
        state.roomCode = ""
        state.joinUrl = ""
        state.joinQr = null
        syncAdvertisement()
    }

    /**
     * The LAN room record, resynced from the three roads that change whether this
     * room can be joined: the room warming, a roster movement, the ticket coming
     * down.
     *
     * THE ROOM CODE COMES FROM [net], NOT FROM [state]. `state.roomCode` is a
     * display field, and the screenshot harness writes "TEST" straight into it to
     * photograph a lobby — reading it here would put a fixture room on the air
     * during every gallery capture. `net.roomCode` is only ever set by the walk
     * that owns a real relay room, so the harness cannot reach it.
     *
     * A FULL ROOM IS WITHDRAWN, and republished when a slot frees. The launcher
     * does hide a full room when it resolves the code (it compares `clients`
     * against `maxClients`), but it only re-resolves when a record APPEARS — so
     * going quiet is what takes the stale card down promptly.
     *
     * [suspended] covers the background: the room may survive the wake, but
     * nothing is watching it until the rejoin, and a discovered join would land a
     * player in front of a dead display.
     */
    private fun syncAdvertisement() {
        val room = net.roomCode
        val seated = state.seats.count { !it.open }
        if (suspended || room.isNullOrEmpty() || seated >= proto.maxPlayers) {
            advertiser.withdraw()
            return
        }
        advertiser.advertise(room)
    }

    /**
     * Back on screen, with a fresh room.
     *
     * Any race that was running belongs to a party that no longer exists — its
     * phones were told the room closed — so the session goes before the lobby comes
     * back. Leaving it up would put a HUD over cars nobody can steer.
     */
    fun resume() {
        if (!suspended) return
        suspended = false
        if (sessionHandle != 0) returnToLobby()
        net.resumeWithFreshRoom()
        refreshLobby()
    }

    // -- the race-flow entry points -------------------------------------------

    /**
     * The host pressed START. ONE walk: the go/no-go (room phase, scene, pick,
     * connected players — all read off the room handle in C++), the bag draws a
     * random pick needs, the cup series stood up behind the room, and the launch
     * effects.
     */
    fun startRace(countdownSeconds: Int? = null, forceItem: String? = null,
                  sceneReady: Boolean? = null) {
        val d = TtpJson.obj(Ttp.ttp_race_start_live_json(
            net.roomHandle,
            if (sceneReady ?: display.hasScene) 1 else 0,
            Random.nextInt().toUInt().toDouble(),
            (countdownSeconds ?: proto.countdownSeconds).toDouble(),
            TtpJson.arg(forceItem), null))
        if (d.optString("action") != "launch") {
            // Same reason announceRoomReady logs: a TV has no console, and a
            // silently refused Start is indistinguishable from a dead button.
            Log.i(TAG, "start refused: ${d.opt("reason")}")
            return
        }
        run(d)
        armCountdown(d)
    }

    /**
     * Stand a race up with no lobby, no countdown and no party, for [Scenarios].
     *
     * It is the SAME session the real race uses — a harness that faked the field
     * would photograph a screen the game cannot produce — and what it fabricates is
     * three inputs: which pick is stored, who is seated, and a countdown of zero.
     *
     * FAKE HUMANS, NOT AN EMPTY ROSTER. The launch gives a split-screen CELL to
     * human seats and none to the CPUs that top the grid up, so launching with
     * nobody seated produces a legal race rendered under ONE overview camera — a
     * pretty picture of the track, and not the screen the gallery is for. How many
     * is the harness's ([Scenarios] takes it from an intent extra); four is the 2x2
     * grid the web's `racing` card photographs.
     *
     * THE SEATS DRIVE THEMSELVES because [Scenarios] latches
     * `ttp_race_autopilot_players` before any of this — the launch is a real
     * launch, so an unsteered seat would pile into the first corner.
     *
     * THE PICK GOES ON FIRST, seats second, and the order is the walk's rule rather
     * than a preference: [PartyNet.applyPick] rides the null-sender road, which is
     * admitted only while the room has NO HOST, and the first seated player becomes
     * host. A pick applied after the seats is refused, and the refusal surfaces one
     * step later as `start refused: no-track` — i.e. as a photograph of the lobby
     * attract filed under the name of a race.
     *
     * PRESENCE IS FABRICATED WHERE IT LIVES. The live twins read the ROOM for who is
     * seated and who has dropped, so the scripted party is SEATED rather than
     * special-cased at each read; the tvOS shell tried the special case first, and
     * the post-GO auto-pause re-check walked straight past it, read an empty room as
     * a race with nobody in it, and returned every shot to the lobby.
     */
    fun startDemoRace(pick: JSONObject, forceItem: String?, humans: Int) {
        net.applyPick(pick)
        for (i in 0 until humans) {
            // A NUMERIC peer index, which is what a phone's seat really is —
            // `EngineId.string("1")` and `EngineId.number(1)` are two different
            // players to `ttp::parse_scalar_id`.
            val id = EngineId.number(i + 1)
            Ttp.ttp_room_add_player(net.roomHandle, TtpJson.arg(id.json), TtpJson.arg(JSONObject()
                .put("name", Scenarios.nameFor(i))
                .put("colorIndex", i)
                .put("carIndex", i)
                .put("ready", false)
                .toString()))
        }
        // THROUGH THE SAME WALK THE START BUTTON TAKES. Building a launch payload
        // here instead is how fifteen tvOS race screenshots looked perfect for a
        // build whose Start button had never once worked: the harness reached the
        // launch directly, so it photographed a countdown the only real road could
        // not produce. `sceneReady` is vouched for because the launch's own
        // reset-scene-cars is what builds the scene.
        startRace(countdownSeconds = 0, forceItem = forceItem, sceneReady = true)
    }

    /**
     * The cup chain: RESULTS straight into the next COUNTDOWN, with no lobby step
     * in between. ONE walk: verdict, the series advanced, the pick re-aimed at the
     * cup's next circuit (the net set-track tail merges into the answer) and the
     * launch — nothing sequenced here.
     */
    fun advanceSeriesRace() {
        val d = TtpJson.obj(Ttp.ttp_race_advance_live_json(
            net.roomHandle, if (display.hasScene) 1 else 0,
            Random.nextInt().toUInt().toDouble(),
            proto.countdownSeconds.toDouble(), null, null))
        when (d.optString("action")) {
            "return-to-lobby" -> returnToLobby()   // everyone left mid-intermission
            "advance" -> { run(d); armCountdown(d) }
            else -> Unit                            // "none"
        }
    }

    /**
     * Hold a launch's countdown until the scene it will be driven on has settled.
     * Both launch paths arm through here, so a chained cup race waits exactly as
     * a lobby start does.
     */
    private fun armCountdown(answer: JSONObject) {
        val effects = answer.optJSONArray("countdownEffects")
        pendingCountdown =
            if (effects == null || effects.length() == 0) null else effects to nowMs()
    }

    /**
     * Asked once a frame while a launch waits. True on the frame the countdown
     * actually starts, so the caller can skip the rest of that tick.
     *
     * The rule and everything it weighs are `ttp_race.h`'s: this side reports only
     * the fact it owns (did my build land) and its own clock. The frame evidence is
     * read inside, off the window this shell is already feeding, so a countdown can
     * never be gated on numbers the readout disagrees with.
     */
    private fun releaseCountdown(): Boolean {
        val waiting = pendingCountdown ?: return true
        // `measuring` is 1 unconditionally here: this shell feeds ttp_perf_sample
        // on every frame, with no automation or pinned-scale path that turns it
        // off (the web has both).
        if (Ttp.ttp_race_countdown_ready(if (sceneBuildOk) 1 else 0, 1,
                                         nowMs() - waiting.second) == 0) return false
        pendingCountdown = null
        run(JSONObject().put("effects", waiting.first))
        return true
    }

    /**
     * Back to the lobby from anywhere. The executor cancels a running cup and
     * re-rolls a random pick's next preview from the room's bag.
     */
    fun returnToLobby() {
        val d = TtpJson.obj(Ttp.ttp_race_return_live_json(net.roomHandle))
        if (d.optString("action") != "return") return
        run(d)
    }

    /**
     * Pull a player's car out of the live race (a clean LEAVE, or a dropped seat
     * the liveness sweep gave up on). sessionHandle 0 is legal (the no-car
     * effects).
     */
    fun forfeit(id: EngineId) =
        run(TtpJson.obj(Ttp.ttp_race_forfeit_live_json(sessionHandle, TtpJson.arg(id.json))))

    /**
     * A dropped player came back on a different device. The session rekey, the
     * banked cup points (they follow the PLAYER) and the room-retained field row
     * all move inside the walk; what comes back is only the scene op.
     */
    fun rekey(old: EngineId, new: EngineId) = run(TtpJson.obj(Ttp.ttp_race_rekey_live_json(
        sessionHandle, net.roomHandle, TtpJson.arg(old.json), TtpJson.arg(new.json))))

    fun refreshAutoPause() {
        // The input, the consult gate, the synced participants read AND the effects
        // are one walk. `raceEnded` is the one input that stays: the results-overlay
        // latch, which no handle knows. Cheap on the lobby's roster renders: the
        // gate inside says no before anything is gathered.
        run(TtpJson.obj(Ttp.ttp_race_auto_pause_live_json(
            sessionHandle, net.roomHandle, if (raceEnded) 1 else 0)))
    }

    /**
     * Walk whatever the layer answered. Every entry point above funnels through
     * here so there is exactly one place effects are performed, in order.
     */
    fun run(answer: JSONObject, results: JSONObject? = null) {
        performer.perform(
            answer.optJSONArray("effects") ?: JSONArray(),
            RaceFlowPerformer.Context(results),
        )
    }

    // -- the net edge ---------------------------------------------------------

    private fun wireNet() {
        net.onRoomReady = { code, url ->
            state.roomCode = code
            state.joinUrl = url
            state.joinQr = QRCode.bitmap(url)
            // A WARM ROOM MEANS WHATEVER WENT WRONG RECOVERED. The commonest
            // banner by far is "relay: Room not found", which is the crash-recovery
            // blob dialling a room the relay no longer has — and the walk's answer
            // to that is the fresh create that just landed here. Leaving a red
            // error on screen for a condition the app healed by design trains
            // everyone to ignore the one channel this app has for saying something
            // is actually wrong.
            state.clearError()
            syncAdvertisement()
        }
        net.onRoomGone = { clearJoinTicket() }
        net.onRosterChanged = { refreshLobby() }
        net.onRaceAbandoned = { returnToLobby() }
        net.onClose = { roomClosed ->
            if (roomClosed) {
                if (sessionHandle != 0) returnToLobby()
                clearJoinTicket()
                landOnFreshLobby()
            }
        }
        net.onControllerMessage = { from, msg -> handleControllerMessage(from, msg) }
        net.onPlayerWelcomed = { id -> relightItem(id); refreshLobby() }
        net.onPlayerLeave = { id ->
            if (sessionHandle != 0) forfeit(id)
            refreshLobby()
        }
        net.onPlayerRekey = { old, new -> rekey(old, new) }
        net.onPlayerRenamed = { id, name -> renamePlayer(id, name) }
        net.onReconnectSeats = { seats -> applyReconnectCards(seats) }
        net.onTrackChange = { id ->
            // Remember every confirmed pick's resolved circuit: it is what the NEXT
            // party's lobby attracts on before anyone joins. The walk only ever
            // resolves catalogue tracks, so no membership check.
            if (id.isNotEmpty()) prefs.edit().putString(LAST_TRACK_KEY, id).apply()
            setTrack(id)
            refreshLobby()
        }

        // What PartyNet needs FROM the game, as closures rather than a back
        // reference, so the transport half stays unable to reach the race half.
        net.sessionHandle = { sessionHandle }
        // Manual pause only: the silent auto-pause lifts on the reconnect itself.
        net.isPaused = { state.paused }
        net.onRelayError = { why -> state.fail("relay: $why") }

        audio.onSongChanged = { title, artist, license, source ->
            state.musicCredit = GameState.MusicCredit(title, artist, license, source)
        }

        lobbyDemo.room = { net.roomHandle }
        lobbyDemo.trackId = { trackId }
        // THE ROSTER, THEN THE BIND. `onField` puts the attract grid into the scene
        // the renderer draws from; without it the demo races invisibly.
        lobbyDemo.onField = { field -> setDemoSceneCars(field) }
        lobbyDemo.onRedress = { field -> redressDemoSceneCars(field) }
        lobbyDemo.onSession = { handle -> display.bind(handle) }

        display.onFrame = { dt -> frame(dt) }
        display.onSlowTick = { slowTick() }
        // Fires once, when a built scene first reaches the glass. At boot the
        // preview pick lands long before the pixels do, so without this nothing
        // ever re-asks and the boot cover would stay up for the whole lobby —
        // the mirror of the flash it exists to stop.
        //
        // DELAYED BY THE FADE, and the delay is the point. Revealing the backdrop
        // is a [BACKDROP_FADE_MS] fade of the lobby's paper off the live scene;
        // lift the cover the moment the scene paints and it uncovers that fade
        // half-run, so the opening reads as THREE steps — title, wallpaper,
        // circuit — where it should be two. The fade runs UNDER the cover and the
        // cover outlasts it. The wait is free: it is spent on an animation nobody
        // was meant to watch. tvOS holds its cover the same way.
        display.onFirstPaint = { main.postDelayed({ refreshCover() }, BACKDROP_FADE_MS.toLong()) }
    }

    /**
     * The clock every walk and the audio mix are told about.
     *
     * MONOTONIC (`ttp_audio.h` says so at `ttp_audio_frame`), so an NTP
     * correction — routine shortly after a TV box boots — cannot step it. Not
     * `System.currentTimeMillis()`, which the tvOS twin uses and which would jump
     * the one-shot spacing gates, the race-event dating and every liveness
     * deadline at once. Safe to change wholesale because every value in this
     * domain originates here: `race_flow.cc` computes its intermission deadline
     * as `nowMs + intermissionMs` from the value this hands it, so the deadline
     * and the reading against it are always the same clock.
     */
    private fun nowMs(): Double = SystemClock.elapsedRealtime().toDouble()

    /**
     * One race frame. THREE crossings and no more: the sim tick, the event drain,
     * and the audio frame. Nothing about a car is serialized out.
     */
    private fun frame(dt: Double) {
        if (sessionHandle != 0) {
            // THE COUNTDOWN GATE. The grid is dressed, framed and painted by now;
            // "3, 2, 1" waits here until the scene has stopped assembling itself.
            // Skipping the update while it waits costs nothing — the countdown
            // holds the cars anyway, so this only extends the pose they were
            // already in.
            if (!releaseCountdown()) { audio.frame(nowMs()); return }
            Ttp.ttp_update(sessionHandle, dt * 1000)
            // Drained IMMEDIATELY after the update: the event queue is per-handle
            // and a second update would overwrite it.
            drainRaceEvents()
        }
        audio.frame(nowMs())
    }

    /**
     * The frame's one drain. WHICH events do what is decided inside the engine off
     * the queued events and the two live handles.
     *
     * `results` rides the ANSWER because no effect can carry it: it is non-null
     * exactly when the drain crossed the race's end.
     */
    private fun drainRaceEvents() {
        if (sessionHandle == 0) return
        val d = TtpJson.obj(Ttp.ttp_race_events_live_json(
            sessionHandle, net.roomHandle, TtpJson.arg(display.biome),
            if (audio.ready) 1 else 0, if (fastForwarding) 1 else 0,
            Ttp.ttp_race_intermission_ms(), nowMs(), Ttp.ttp_race_results_failsafe_ms()))
        run(d, d.optJSONObject("results"))
    }

    /**
     * The ~6 Hz poll. Everything the DOM used to be written for per frame lives
     * here instead, and the finish check rides it rather than asking sixty times a
     * second whether anyone has crossed the line.
     */
    private fun slowTick() {
        if (sessionHandle == 0 || state.screen != GameState.Screen.RACE) return
        paintHUD(display.hud())
        pushItems()

        // THE FORFEITS BELONG INSIDE THE allDone ARM, as on the web. `forfeit[]`
        // names every disconnected human EVERY poll — outside the arm it forfeits a
        // dropped-but-reconnectable racer six times a second, and with one phone
        // down the auto-pause freeze turns into a return to the lobby.
        val flow = TtpJson.obj(Ttp.ttp_ui_race_flow_live_json(sessionHandle, net.roomHandle))
        if (flow.optBoolean("allDone") && !raceEnded) {
            val f = flow.optJSONArray("forfeit") ?: JSONArray()
            for (i in 0 until f.length()) EngineId.from(f.opt(i))?.let { forfeit(it) }
            fastForwardToEnd()
        }
    }

    /**
     * Every human is home: resolve the rest of the race at once.
     *
     * NOT COSMETIC. Ending the race straight from here would end it with the BOTS
     * STILL MID-LAP, so they reach the results board unfinished and the standings a
     * TV shows differ from the ones a browser shows for the same race. The burst
     * runs the deterministic sim on to its own end with no rendering, so every car
     * finishes (or DNFs) the way it would have.
     *
     * THE HOLD COMES FIRST. `ttp_fast_forward` advances the world with no frames,
     * and a just-finished human keeps driving a victory lap — so without freezing
     * the field at the finish moment the chase camera is seen whipping across the
     * track to a far-away pose, through the translucent results glass.
     */
    private fun fastForwardToEnd() {
        if (sessionHandle == 0 || Ttp.ttp_racing(sessionHandle) == 0) return
        display.hold(true)
        fastForwarding = true
        Ttp.ttp_fast_forward(sessionHandle)
        // Drained here rather than left for the next frame: the burst queues every
        // remaining finish AND the race's end, and the next ttp_update would
        // overwrite the queue.
        drainRaceEvents()
        fastForwarding = false
    }

    private fun paintHUD(slots: List<DisplayHost.HudSlot>) {
        // The cars that own a view, in the order they were named to
        // `ttp_display_cells` — so index i here is cell i there, and there is no
        // per-car cell NUMBER to look up because the model never sends one.
        val viewed = sceneCars.filter { it.cell }
        // The ABI answers FRACTIONS of the surface, so these scale by the
        // AUTHORED canvas and by nothing the render scale can move. The buffer
        // width used to be the divisor, and it reached Compose by a road Compose
        // could not watch — see TtpTheme.toAuthored for what that cost.
        val rects = display.cellRects().map { it.toAuthored() }
        val roster = display.roster
        val cells = ArrayList<GameState.CellHUD>()
        var cardMask = 0

        for ((i, rect) in rects.withIndex()) {
            if (i >= viewed.size) break
            val car = viewed[i]
            val slot = slots.firstOrNull { roster.getOrNull(it.slot) == car.id }
            val reconnecting = shownReconnectIds.contains(car.id)
            val finished = slot?.finished ?: false
            // FINISHED wins if both, and the mask is what tells the RENDERER to
            // drop that cell's steer bar — pushed before the frame draws, or the
            // bar shows for one frame under the card.
            if (finished || reconnecting) cardMask = cardMask or (1 shl i)

            cells.add(GameState.CellHUD(
                index = i,
                car = car.id,
                rect = rect,
                name = car.name,
                colorIndex = car.colorIndex,
                carIndex = car.carIndex ?: 0,
                place = slot?.place ?: 0,
                lap = slot?.lap ?: 0,
                totalLaps = slot?.totalLaps ?: 0,
                item = slot?.let { itemKey(it.item) },
                finished = finished,
                finishTime = slot?.finishTime,
                reconnecting = reconnecting && !finished,
                reconnectUrl = reconnectUrls[car.id],
            ))
        }
        display.cellCards(cardMask)
        // WRITE ONLY WHAT MOVED. `clear()` then `addAll()` is two structural changes
        // to a SnapshotStateList, so every reader of it — which is the whole race
        // chrome — was invalidated six times a second whether or not one field
        // differed. Measured on the Streamer with `atrace`: ~4.5 ms of recomposition
        // on the frame after each poll, p95 39 ms, on the thread the renderer draws
        // on. `CellHUD` is a data class, so "did anything move" is `!=`, and a poll
        // that changed nothing now writes nothing and recomposes nothing.
        if (state.cells.size != cells.size) {
            state.cells.clear()
            state.cells.addAll(cells)
        } else {
            for (i in cells.indices) {
                if (state.cells[i] != cells[i]) state.cells[i] = cells[i]
            }
        }
    }

    /**
     * Relight a (re)joining phone's held item, once.
     *
     * A phone recovers all its room and results state from the retained snapshot
     * replay, but the held ITEM is per-owner and rides its own message SENT ONLY ON
     * CHANGE — so without this a driver who reconnects mid-race sits there with a
     * dark USE button until their next pickup, holding an item they cannot see.
     */
    private fun relightItem(id: EngineId) {
        if (sessionHandle == 0) return
        val answer = TtpJson.strOrEmpty(
            Ttp.ttp_ui_welcome_item_live_json(sessionHandle, TtpJson.arg(id.json)))
        val value = try { JSONArray("[$answer]").opt(0) } catch (_: Throwable) { null }
            ?: JSONObject.NULL
        lastItem[id] = value
        net.sendTo(id, JSONObject().put("type", proto.msgItem).put("item", value).toString())
    }

    /**
     * A held item crosses as a CODE, never a string. The table is DERIVED from
     * `ttp_item_id` rather than mirrored, so a new item cannot be half-added.
     */
    private fun itemKey(code: Int): String? =
        if (code < 1) null else TtpJson.str(Ttp.ttp_item_id(code))

    /**
     * The per-phone ITEM push. The GATE is the model's — it reads the live session
     * itself and decides which phones are owed a message; `lastItem` is the memory
     * that gate reads, and it distinguishes null from absent (a slot that went from
     * null to absent pushes again — three states, not two).
     */
    private fun pushItems() {
        if (sessionHandle == 0) return
        val last = JSONArray()
        for ((id, item) in lastItem) {
            last.put(JSONObject().put("id", id.boxed()).put("item", item))
        }
        val pushes = TtpJson.arr(Ttp.ttp_ui_item_pushes_live_json(
            sessionHandle, TtpJson.arg(last.toString())))
        for (i in 0 until pushes.length()) {
            val p = pushes.optJSONObject(i) ?: continue
            val id = EngineId.from(p.opt("id")) ?: continue
            val item = p.opt("item") ?: JSONObject.NULL
            net.sendTo(id, JSONObject().put("type", proto.msgItem).put("item", item).toString())
            lastItem[id] = item
        }
    }

    // -- the lobby ------------------------------------------------------------

    /**
     * Re-read the lobby from the ROOM HANDLE. There is no roster copy in this shell
     * to keep in step: `ttp_ui_roster_seats_room_json` reads the room's own records
     * across the `ttp_room.h` seam, and `ttp_ui_seat_grid_json` pads the result to
     * `maxPlayers` with open placeholders.
     */
    fun refreshLobby() {
        val seats = TtpJson.strOrEmpty(Ttp.ttp_ui_roster_seats_room_json(
            net.roomHandle, TtpJson.arg(net.hostIdJson)))
        val grid = TtpJson.arr(Ttp.ttp_ui_seat_grid_json(TtpJson.arg(seats)))
        state.seats.clear()
        for (i in 0 until grid.length()) {
            val d = grid.optJSONObject(i) ?: continue
            state.seats.add(GameState.Seat.from(d, i))
        }

        // The join plink, and the attract demo's debounce. Both ride the roster
        // render on the web for the same reason they do here: this is the one place
        // that knows the roster moved.
        audio.roster(state.seats.count { !it.open }, state.screen == GameState.Screen.LOBBY)
        if (state.screen == GameState.Screen.LOBBY) lobbyDemo.refresh()

        // The right rail's race card. It rides the ROSTER render for the same
        // reason the web's does: the pre-pick slot names the host, so a join or a
        // rename changes it. Nothing outside the screenshot harness called this on
        // tvOS, so on the live board the rail stayed empty through every pick.
        refreshCupSlot()

        // No publish here, deliberately: every road into this render is a walk that
        // already published.

        // The LAN record rides the roster too: a room that just filled must go off
        // the air, and one that just freed a slot must come back on.
        syncAdvertisement()

        // THE SILENT AUTO-PAUSE RIDES THE ROSTER, exactly as on the web. Every
        // roster movement is a candidate: a disconnect, a reconnect, a rekey, a
        // leave, a seat expiry. Without this the freeze only ever ran from the
        // deferred post-GO re-check, so a party that walked away MID-RACE left the
        // cars driving themselves on a television nobody was holding a phone at.
        refreshAutoPause()
    }

    /**
     * The "game" bucket: everything the peer-message walk did not handle as a seat
     * rule. Every button press routes through `ttp_net_controller_action`, gates
     * included: START_GAME needs the host AND every other racer ready, SERIES_NEXT
     * is host-only, pause/resume are any player's, and re-deriving any of that here
     * is exactly the if-chain the verdict replaced.
     */
    private fun handleControllerMessage(from: EngineId, msg: JSONObject) {
        val type = msg.optString("type").ifEmpty { return }
        if (type == proto.msgControl) {
            // CONTROL stays on its own short-circuit: it is the relay-fallback INPUT
            // path, and adding a crossing there was measured and refuted.
            if (sessionHandle == 0) return
            // THE MASK IS DERIVED HERE, NEVER SENT. It is a PRESENCE bitmask over
            // the three fields (1 = s, 2 = b, 4 = u) and the ABI leaves an absent
            // field UNTOUCHED on the car — which is what makes a partial CONTROL
            // legal, and what makes a wrong mask silent.
            //
            // tvOS read `msg["mask"]` for a while. There is no such key on the wire
            // (`controller/Net.js` sends `{s, b, u, type}`), so the mask was 0 on
            // every sample: "nothing present", every field skipped, every car left
            // un-steered for the whole race. Nothing errored and the packets all
            // arrived.
            var mask = 0
            var s = 0.0; var b = 0.0; var u = 0.0
            if (msg.has("s") && !msg.isNull("s")) { mask = mask or 1; s = msg.optDouble("s") }
            // `b` is a number OR a bool, matching the reader this was ported from —
            // a phone that sends `true` must brake, not be ignored.
            if (msg.has("b") && !msg.isNull("b")) {
                mask = mask or 2
                b = when (val v = msg.opt("b")) {
                    is Boolean -> if (v) 1.0 else 0.0
                    is Number -> v.toDouble()
                    else -> 0.0
                }
            }
            if (msg.has("u") && !msg.isNull("u")) { mask = mask or 4; u = msg.optDouble("u") }
            // Applied on ARRIVAL rather than queued for the next tick: the input
            // path is microseconds, and buffering it would add a frame of latency
            // to the one thing players feel.
            //
            // AND THE ANSWER IS CHECKED, ONCE PER SESSION. `ttp_process_input`
            // returns the mask it consumed, -1 for an identity matching no car,
            // 0 for a well-formed call carrying nothing — the three ways to steer
            // nothing, which used to be indistinguishable from success because it
            // returned void. That is not a hypothetical: the first TV shell read a
            // `mask` key off the message, got 0 on every sample, and steered
            // nothing for the life of the port with no error anywhere.
            //
            // ONCE, not per sample. The header is explicit that the hot path has
            // no error handling and that a shell should "assert on it once instead
            // of discovering the answer on a television" — so the first sample
            // that applies something latches, and the first that does not says so
            // and then goes quiet. Logging at sensor rate would bury the report in
            // its own repeats.
            val took = Ttp.ttp_process_input(sessionHandle, TtpJson.arg(from.json), mask, s, b, u)
            if (!inputProven) {
                if (took > 0) {
                    inputProven = true
                } else if (!inputReported) {
                    inputReported = true
                    state.fail(when (took) {
                        -1 -> "input: no car for ${from.text} — every CONTROL from this seat steers nothing"
                        else -> "input: CONTROL from ${from.text} carried nothing to apply (mask $mask)"
                    })
                }
            }
            return
        }
        when (TtpJson.strOrEmpty(Ttp.ttp_net_controller_action(
            net.roomHandle, sessionHandle, TtpJson.arg(from.json), TtpJson.arg(type)))) {
            "start-race" -> startRace()
            "series-next" -> advanceSeriesRace()
            "pause" -> pauseRace()
            "resume" -> resumeRace()
            "return-to-lobby" -> returnToLobby()
            else -> Unit   // "none" — refused, or not a word this layer knows
        }
    }

    /**
     * The lobby's right rail: which name, how many races, the difficulty pips and
     * which circuits to draw as minis.
     *
     * EVERY FIELD IS `ttp_ui_cup_slot_json`'s, keys plus data and never composed
     * copy. Null before the host has picked, which the view renders as no card at
     * all rather than an empty one.
     */
    fun refreshCupSlot() {
        val pick = net.pick
        state.cupSlot = GameState.CupSlot.from(
            TtpJson.obj(Ttp.ttp_ui_cup_slot_json(TtpJson.arg(pick.toString()))))?.veiled()
    }

    private fun setDemoSceneCars(field: JSONArray) {
        sceneCars = demoSceneCars(field)
        rebuildScene()
    }

    /**
     * The demo's in-place pick swap: same slots, new liveries/models/names.
     * `ttp_display_reroster` keeps the meshes, the baked shadows and the preview
     * camera's orbit phase — the full rebuild this used to pay is why choosing a car
     * on a phone visibly snapped the lobby camera back to its start bearing.
     */
    private fun redressDemoSceneCars(field: JSONArray) {
        sceneCars = demoSceneCars(field)
        if (!SceneStaging.redress(rosterSlots(), display, assets)) rebuildScene()
    }

    private fun demoSceneCars(field: JSONArray): List<SceneCar> =
        (0 until field.length()).mapNotNull { i ->
            val p = field.optJSONObject(i) ?: return@mapNotNull null
            val id = EngineId.from(p.opt("id")) ?: return@mapNotNull null
            SceneCar(
                id = id,
                colorIndex = p.optInt("colorIndex"),
                name = TtpJson.optStr(p, "name") ?: "",
                // `cell: false` throughout — the lobby keeps its single overview
                // camera.
                cell = false,
                carIndex = if (p.has("carIndex") && !p.isNull("carIndex"))
                    p.optInt("carIndex") else null,
            )
        }

    /**
     * The dropped seats awaiting a rejoin. The DIFF is the model's: it answers
     * which cards to attach and which to drop, against the set this shell says is
     * currently shown.
     */
    private fun applyReconnectCards(seats: List<JSONObject>) {
        val shown = JSONArray()
        for (id in shownReconnectIds) shown.put(id.boxed())
        // `peerIndex`, NOT `id`. These are ttp_net_reconnect_card_json answers and
        // that payload is {peerIndex,name,colorIndex,url} — session.cc's copyKey
        // names the three keys and `id` is not among them. Reading `id` matched no
        // seat, so the diff answered an empty `add` and a dropped racer's cell never
        // showed its reconnect QR: their car kept racing with no way to rejoin it,
        // silently. tvOS has the identical bug; the WEB is the correct twin.
        //
        // Built POSITIONALLY, nulls included, because `add` carries POSITIONS into
        // this list — a compacted array would shift them.
        val wanted = JSONArray()
        for (s in seats) wanted.put(EngineId.from(s.opt("peerIndex"))?.boxed() ?: JSONObject.NULL)

        val diff = TtpJson.obj(Ttp.ttp_ui_reconnect_diff_json(
            TtpJson.arg(shown.toString()), TtpJson.arg(wanted.toString())))

        val remove = diff.optJSONArray("remove") ?: JSONArray()
        for (i in 0 until remove.length()) {
            EngineId.from(remove.opt(i))?.let { shownReconnectIds.remove(it); reconnectUrls.remove(it) }
        }
        // `add` carries POSITIONS into the seat list while `remove` carries IDS —
        // the mixed convention ttp_ui.h documents on the diff. Reading the positions
        // as ids matches no seat, and then no reconnect QR ever attaches: the
        // dropped racer's cell shows an empty card frame with nothing to scan.
        val add = diff.optJSONArray("add") ?: JSONArray()
        for (i in 0 until add.length()) {
            val pos = add.optInt(i, -1)
            if (pos < 0 || pos >= seats.size) continue
            val card = seats[pos]
            val id = EngineId.from(card.opt("peerIndex")) ?: continue
            // The card is used AS HANDED. Re-composing it here would overwrite its
            // `url` with the generic join URL and throw away the per-seat
            // `?claim=<peerIndex>` PartyNet spliced in — so the QR would drop the
            // player into a NEW seat instead of reclaiming theirs, leaving their
            // still-racing car unrekeyed.
            shownReconnectIds.add(id)
            TtpJson.optStr(card, "url")?.let { reconnectUrls[id] = it }
        }
    }

    // -- the race -------------------------------------------------------------

    /**
     * `create-session`. The FIELD rides the op (the executor composed it), and the
     * bots' personas arrive on it rather than being looked up.
     *
     * `ttp_session_begin_field` is begin plus the WHOLE field in one pass — the
     * construction loop every shell used to hand-write, and THE STATS ARE THE
     * FIELD'S: tvOS read them off the bot spec for a while, which has none, silently
     * handing every bot the benchmark defaults.
     */
    fun createSession(field: JSONArray, seed: Double, forceItem: String?, bots: JSONArray) {
        disposeSession()
        inputProven = false
        inputReported = false
        // The seed crosses the walk as a DOUBLE (it is JSON) and the session ABI as
        // a uint32. `toRawBits`-style truncation is what the tvOS twin spells as
        // `UInt32(truncatingIfNeeded:)`: the walk's own seed is already in range,
        // and a value that is not must wrap rather than saturate, or two different
        // seeds would produce the same race.
        sessionHandle = Ttp.ttp_session_begin_field(
            TtpJson.arg(trackId), seed.toLong().toInt(), laps, TtpJson.arg(forceItem),
            TtpJson.arg(field.toString()), TtpJson.arg(bots.toString()))
        if (sessionHandle == 0) {
            // The REASON is the engine's — unknown track, refused lap count —
            // rather than this line guessing from the one bit it was handed.
            requireOK(false, "starting a race on '$trackId'")
        }
    }

    fun disposeSession() {
        // …and with it any countdown still waiting on that race's scene: an abort
        // mid-gate would otherwise start one over the lobby a beat later.
        pendingCountdown = null
        if (sessionHandle == 0) return
        // Unbind BOTH consumers before disposing: a disposed handle takes its queued
        // audio beats with it, and the display would otherwise read a dead Game for
        // one frame.
        display.bind(0)
        audio.bind(0)
        Ttp.ttp_dispose(sessionHandle)
        sessionHandle = 0
    }

    /**
     * The manual overlay pause/resume, as walks. The verdicts are asked INSIDE, and
     * the op order is the contract — every pause road (the remote's Play/Pause,
     * BACK on a live race, a phone's PAUSE_GAME) ends here and none of them decides.
     */
    fun pauseRace() = run(TtpJson.obj(Ttp.ttp_race_pause_live_json(
        sessionHandle, net.roomHandle, if (state.paused) 1 else 0,
        if (autoPaused) 1 else 0, if (raceEnded) 1 else 0)))

    fun resumeRace() = run(TtpJson.obj(Ttp.ttp_race_resume_live_json(
        sessionHandle, net.roomHandle, if (state.paused) 1 else 0,
        if (autoPaused) 1 else 0, if (raceEnded) 1 else 0)))

    /**
     * The ONE writer of the sim's clock. `ttp_ui_freeze_plan_json` arbitrates, so a
     * manual resume while every racer is still gone keeps the field frozen, and a
     * reconnect during a manual pause keeps the overlay's authority.
     *
     * The answer is the transition AND its member ops in order — thaw is NOT freeze
     * reversed (voices never restart on thaw; cars release before the music
     * returns), and re-spelling the composition at the call site is how one shell
     * already shipped frozen cars that kept squealing.
     */
    fun syncSessionFrozen() {
        val plan = TtpJson.obj(Ttp.ttp_ui_freeze_plan_json(
            if (state.paused) 1 else 0,
            if (autoPaused) 1 else 0,
            if (sessionHandle != 0 && Ttp.ttp_paused(sessionHandle) != 0) 1 else 0))
        val ops = plan.optJSONArray("ops") ?: JSONArray()
        for (i in 0 until ops.length()) {
            when (ops.optString(i)) {
                "pause-session" -> if (sessionHandle != 0) Ttp.ttp_pause(sessionHandle)
                "resume-session" -> if (sessionHandle != 0) Ttp.ttp_resume(sessionHandle)
                "stop-voices" -> audio.stopVoices()
                "pause-music" -> audio.setMusicPaused(true)
                "resume-music" -> audio.setMusicPaused(false)
                "hold-cars" -> display.hold(true)
                "release-cars" -> display.hold(false)
                else -> state.fail("freeze op this build cannot perform: ${ops.optString(i)}")
            }
        }
    }

    private fun rosterSlots(): List<RosterSlot> = sceneCars.map {
        RosterSlot(
            id = it.id,
            name = it.name,
            carIndex = it.carIndex ?: 0,
            color = proto.carColors.getOrElse(it.colorIndex) { "" },
            model = proto.carModels.getOrElse(it.carIndex ?: 0) { proto.carModels[0] },
        )
    }

    fun rebuildScene() {
        // The cells are the cars that own a split-screen view, in roster order —
        // which IS cell order, and is the only place that mapping exists.
        display.setCells(sceneCars.filter { it.cell }.map { it.id })
        // THE COUNTDOWN GATE'S HALF OF THE QUESTION, and on this platform it is
        // answered by the time this returns: `display.build` is synchronous here,
        // unlike the web's promise and the tvOS Task. What is still worth
        // carrying is whether it SUCCEEDED — a refused build leaves the previous
        // scene up, and warm frames of that scene say nothing about this race.
        sceneBuildOk = display.build(trackId, rosterSlots(), assets)
        if (sceneBuildOk) {
            // The boost icon's chevrons are the BIOME's accent, chosen for contrast
            // with this track's deck rather than to match the scenery, so it can
            // only be read once the build has resolved which biome won.
            state.boostAccent = Ttp.ttp_theme_boost_icon(TtpJson.arg(display.biome))
        }
    }

    fun placeTrack() = rebuildScene()

    /**
     * Swap the circuit the lobby previews and the next race builds.
     *
     * **A NO-OP WHEN THE TRACK DID NOT MOVE**, which is not an optimisation: a
     * rebuild is a track mesh plus a 2048x2048 shadow bake, run on the main thread,
     * and the whole UI is frozen for it.
     *
     * AND IT DOES NOT BUILD IN THE LOBBY, because the attract demo is about to.
     * Building here first meant every pick paid for TWO full scene builds back to
     * back, the first of them for an empty roster — which is what "switching cups
     * hangs the lobby" was.
     */
    fun setTrack(id: String) {
        if (id == trackId) return
        trackId = id
        // The pick is what lifts the paper off the lobby (see refreshBackdrop):
        // before it there is no scene to show, after it there is.
        refreshBackdrop()
        if (state.screen != GameState.Screen.RACE && !lobbyDemo.willRebuild(id)) rebuildScene()
    }

    fun fadeToLobby(shouldPlace: Boolean) {
        sceneCars = emptyList()
        if (shouldPlace) rebuildScene() else display.release()
        lobbyDemo.refresh()
    }

    fun removeSceneCar(id: EngineId) {
        sceneCars = sceneCars.filter { it.id != id }
        rebuildScene()
    }

    fun rekeySceneCar(old: EngineId, new: EngineId) {
        sceneCars = sceneCars.map { if (it.id == old) it.copy(id = new) else it }
        display.setCells(sceneCars.filter { it.cell }.map { it.id })
    }

    /**
     * A seated player changed their name.
     *
     * The LOBBY needs nothing: its seat grid is re-read off the room handle on the
     * same announce that delivered this. A RACE still froze one copy at its start —
     * the cell chip — so that is moved by hand, and the board already out is
     * re-pushed.
     *
     * The car's REAR NAME PLATE is untouched and stays stale until the next scene
     * build: it is geometry baked from the build roster. Same on the web.
     */
    private fun renamePlayer(id: EngineId, name: String) {
        sceneCars = sceneCars.map { if (it.id == id) it.copy(name = name) else it }
        // Never a FIRST board: a phone raises its results overlay on a non-null
        // standings.
        if (net.hasStandings()) broadcastStandings(raceEnded, null)
    }

    fun itemPickup(id: EngineId) {
        // The slot-machine spin is the HUD's; this only marks that a FRESH pickup
        // happened, because the slot re-spins even on the same item id.
        state.itemPickupTick[id] = (state.itemPickupTick[id] ?: 0) + 1
    }

    // -- results --------------------------------------------------------------

    fun broadcastStandings(over: Boolean, results: JSONObject?) {
        if (sessionHandle == 0) return
        net.setStandings(standingsBoard(over, results))
    }

    fun showResults(results: JSONObject?) {
        state.results = GameState.ResultsView.from(TtpJson.obj(Ttp.ttp_ui_results_view_json(
            TtpJson.arg(standingsBoard(true, results)), Ttp.ttp_race_intermission_ms())))
    }

    /**
     * The board the TV and every phone render, off `ttp_ui_standings_live_json`:
     * the results rows, the room-retained race FIELD (rename/rekey repairs applied
     * by the walks), the cup half off the room's stored series, and the late
     * joiners + host through the synced seam — every input gathered off the two
     * handles in C++.
     */
    private fun standingsBoard(over: Boolean, results: JSONObject?): String =
        TtpJson.strOrEmpty(Ttp.ttp_ui_standings_live_json(
            sessionHandle, net.roomHandle, if (over) 1 else 0,
            results?.let { TtpJson.arg(it.toString()) }, Ttp.ttp_race_intermission_ms()))

    // -- timers the effects arm ------------------------------------------------

    fun armResultsFailsafe(ms: Double) {
        clearResultsFailsafe()
        val r = Runnable { returnToLobby() }
        resultsFailsafe = r
        main.postDelayed(r, ms.toLong())
    }

    fun clearResultsFailsafe() {
        resultsFailsafe?.let { main.removeCallbacks(it) }
        resultsFailsafe = null
    }

    fun armIntermission(ms: Double, deadline: Double) {
        clearIntermission()
        intermissionDeadline = deadline
        val advance = Runnable { advanceSeriesRace() }
        intermissionTask = advance
        main.postDelayed(advance, ms.toLong())
        // "starting in N" is re-READ from the model every 500 ms rather than counted
        // down locally, so a stalled frame or a suspended app cannot drift the
        // number away from the deadline the phones were told.
        val ticker = object : Runnable {
            override fun run() {
                state.intermissionSecs =
                    Ttp.ttp_ui_intermission_secs(intermissionDeadline, nowMs()).toInt()
                main.postDelayed(this, 500)
            }
        }
        intermissionTicker = ticker
        main.post(ticker)
    }

    fun clearIntermission() {
        intermissionTask?.let { main.removeCallbacks(it) }
        intermissionTicker?.let { main.removeCallbacks(it) }
        intermissionTask = null
        intermissionTicker = null
        state.intermissionSecs = null
    }
}
