package games.couchpad.tinytrack

import java.util.Locale

/**
 * Every user-facing string in the app, in one place.
 *
 * This file exists because of a rule the C side states and this shell obeys:
 * **the model never emits English** (`ttp_ui.h`). `ttp_ui_results_view_json`
 * answers `{titleKey: "cup_champs", cupName: "Sunset"}`, never
 * `"Sunset CHAMPS!"` — so the copy table is the SHELL's, and each of the three
 * shells owns its own. The web's live next to the elements they fill
 * (`main.js`'s `TITLE_COPY` / `SUB_COPY` / `NEWGAME_COPY` / `RACES_COPY`); tvOS
 * and this shell collect them so a localisation pass has one file to read.
 *
 * The strings this file carries are transcribed from
 * `shells/tvos/.../Copy.swift`. Where the web composes with a template literal,
 * the same composition happens here — the two screens must tell the same story,
 * and for the standings board they literally do (the same board goes on the
 * wire to the phones).
 *
 * NOT `strings.xml`. That file holds the launcher label and nothing else: these
 * are keyed off model answers, several are composed from values, and a
 * localisation pass wants them beside the keys they resolve. When one is needed,
 * this object is what gets a resource lookup behind it.
 *
 * PROJECT RULE: no em dashes in user-facing copy; the shipping web writes
 * " · starting in ".
 */
object Copy {

    /**
     * What an unrecognised model key renders as.
     *
     * Deliberately NOT an English fallback and deliberately not empty. A key
     * this shell has no case for means the C++ grew an answer the Kotlin screens
     * do not know about — a real bug whose only symptom is a screen.
     * `"[cup_champs?]"` is visible in a screenshot; `""` and `"Results"` are not,
     * and both would let the gap ship.
     */
    private fun unknown(key: String) = "[$key?]"

    /**
     * Stands in for a piece of DATA the model should have supplied alongside a
     * key it did supply — a different bug from an unknown key, so a different
     * mark. `"?"` is the web's own fallback for a cup with no name.
     */
    const val unknownValue = "?"

    // -- keyed tables -------------------------------------------------------

    /** `cupSlot.racesKey` → the races pill under the cup sticker. */
    fun races(key: String, count: Int): String = when (key) {
        "one" -> "1 race"
        "endless" -> "endless"
        "count" -> "$count races"
        else -> unknown(key)
    }

    /** `resultsView.titleKey` → the results overlay's header. */
    fun title(key: String, cupName: String?): String = when (key) {
        "cup_champs" -> "${cupName ?: unknownValue} CHAMPS!"
        "standings" -> "Standings"
        "results" -> "Results"
        else -> unknown(key)
    }

    /**
     * `resultsView.sub.key` → the intermission subtitle, shown only during a cup
     * intermission; the podium's CHAMPS header says it all on its own.
     *
     * The two keys differ only in whether the series knows its length: an
     * endless cup has no "of N" to print, which is why the model spells them as
     * two keys rather than making the shell test `of != null`.
     */
    fun sub(key: String, cupName: String, race: Int, of: Int?): String = when (key) {
        "cup_race" -> "$cupName · Race $race"
        "cup_race_of" -> "$cupName · Race $race of ${of?.toString() ?: unknownValue}"
        else -> unknown(key)
    }

    /**
     * `resultsView.newGameKey` → the results overlay's primary button. Mid-cup it
     * advances the series; at the end it ends the party.
     */
    fun newGame(key: String): String = when (key) {
        "next_race" -> "Next race ▸"
        "new_game" -> "New Game"
        else -> unknown(key)
    }

    // -- formatters ---------------------------------------------------------

    /**
     * English ordinal for a place. A direct port of `shared/format.js`'s
     * `ordinal()`, 11/12/13 exception included — that exception is the whole
     * reason the function exists, since a naive last-digit rule prints "11st".
     */
    fun ordinal(n: Int): String {
        val t = n % 100
        val u = n % 10
        val suffix = when {
            t in 11..13 -> "th"
            u == 1 -> "st"
            u == 2 -> "nd"
            u == 3 -> "rd"
            else -> "th"
        }
        return "$n$suffix"
    }

    /** The per-cell lap counter, under the place ordinal. */
    fun lap(lap: Int, of: Int): String = "Lap $lap/$of"

    /**
     * A finish time, one decimal.
     *
     * The web uses `Number.prototype.toFixed(1)`, which `String.format` cannot
     * reproduce exactly — a difference real enough elsewhere in this tree that
     * the schematic projection routes through double-conversion's `ToFixed`. It
     * does not matter here: this is a screen string, not a frozen corpus, and the
     * two spellings can only disagree on an exact half at the second decimal of a
     * lap clock. Locale.ROOT so a German TV does not print "12,3s".
     */
    fun seconds(t: Double): String = String.format(Locale.ROOT, "%.1fs", t)

    /** A cup row's running total. */
    fun points(n: Int): String = "$n pts"

    /**
     * What this race added to it. Zero is still printed ("+0") and styled quiet,
     * so the column never goes ragged.
     */
    fun gained(n: Int): String = "+$n"

    /**
     * A results/podium name with the AI tag. Bots keep the tag everywhere —
     * beating them is the story of a short-handed cup.
     */
    fun name(name: String, ai: Boolean): String = if (ai) name + cpuSuffix else name

    /**
     * The countdown banner. `n > 0` is the digit, `0` is GO, anything below is
     * the banner going away.
     */
    fun countdown(n: Int): String? = when {
        n > 0 -> n.toString()
        n == 0 -> go
        else -> null
    }

    // -- wordmark -----------------------------------------------------------

    const val wordmarkLine1 = "TINY TRACK"
    const val wordmarkLine2 = "PARTY!"

    // -- lobby --------------------------------------------------------------

    /**
     * Hangs under the join ticket for the whole lobby — joining stays possible
     * until the race starts.
     */
    const val scanPrompt = "Scan the code with your phone!"

    /**
     * What the ticket's URL line reads while the room is still warming
     * (`.ticket__wait`). The box is the same size either way, so this is what the
     * card holds rather than a gap that later fills.
     */
    const val loading = "Loading…"

    /** The cups shelf's tab (`.cup-shelf__label`), riding its top-left corner. */
    const val cupsShelf = "Cups"

    /**
     * A cup's name on the SHELF drops a trailing " Cup" — the tab already says
     * these are cups, and "Beach Cup / Snow Cup / Backyard Cup" down a narrow
     * column is one word repeated four times. `renderCupShelf` strips it the same
     * way, and only on the shelf: the race card names the cup in full.
     */
    fun shortCup(name: String) = name.removeSuffix(" Cup")

    /**
     * An unfilled seat. `ttp_ui_seat_grid_json` pads the grid with these; the
     * padding is the model's job so three shells cannot pad differently.
     */
    const val openSeat = "Open"

    /** The cup sticker when the host picked Random rather than a cup or a track. */
    const val random = "Random"

    /**
     * The cup sticker for the World Tour: one random track per cup, raced in the
     * cups' difficulty order.
     */
    const val worldTour = "World Tour"

    // -- info board ---------------------------------------------------------

    /** The lobby's ⓘ, which is icon-only on screen — this is what a screen reader
     *  announces. */
    const val info = "Info"

    /**
     * The two central legal pages, as their cards' labels. They are the web
     * footer's own words (`site-foot`), and the URLs they point at are read out of
     * that footer rather than typed here (see [Legal]).
     */
    const val privacy = "Privacy"
    const val imprint = "Imprint"

    /** The attribution board, and the button that opens it. The word matches the
     *  web's /licenses.html title. */
    const val licenses = "Licenses"

    // -- race ---------------------------------------------------------------

    /**
     * The centred card in a player's cell the instant they cross the line. It is
     * written ONCE and then left alone for the rest of the race.
     */
    const val finished = "FINISHED"

    /** GO is the beat the race actually starts on, not a beat before it. */
    const val go = "GO!"

    /**
     * The reconnect card's subtitle, under the dropped player's name and over
     * their rejoin QR. It takes the same cell slot as the FINISHED card, and
     * FINISHED wins if a car is somehow both.
     */
    const val disconnected = "Disconnected"

    // -- pause overlay ------------------------------------------------------

    const val paused = "Paused"
    const val continueLabel = "Continue"

    /**
     * Lower-case "game" here and title-case in `newGame("new_game")`: that
     * difference is in the shipping web copy (a pause-overlay button vs a
     * results-board button) and is transcribed rather than harmonised, because
     * harmonising it would put this shell's screens out of step with the web's
     * for no gain.
     */
    const val newGameLabel = "New game"

    // -- results ------------------------------------------------------------

    /** A car that did not finish inside the race's own time cap. */
    const val dnf = "DNF"

    /**
     * The trailing cell of a `joining` row: a seat that arrived mid-race and
     * races in the next one. It has no time and no points to show.
     */
    const val nextRace = "Next race"

    // THE PADLOCK IS DRAWN, NOT TYPED — see `Sticker.kt`'s `LockGlyph`. A 🔒 on
    // Android is a full-colour bitmap with a gold body, which is both an unvetted
    // colour and the one hue this palette forbids; `shared/trackPicker.js` states
    // the rule ("platform lock glyphs are coloured and clash with the sticker ink")
    // and draws its own. There is deliberately no string here to reach for.

    /**
     * The intermission footer, assembled as `nextUp + trackName + startingIn +
     * secs + ellipsis` — three literals around two values, exactly as the web
     * builds it, so the sentence reads the same on both screens.
     */
    const val nextUp = "Next up: "
    const val startingIn = " · starting in "
    const val ellipsis = "…"

    // -- shared -------------------------------------------------------------

    /** Appended to every AI name on the results list and the podium. */
    const val cpuSuffix = " (CPU)"
}
