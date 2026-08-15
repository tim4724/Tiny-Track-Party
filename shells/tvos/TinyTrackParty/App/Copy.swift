import Foundation

/// Every user-facing string in the app, in one place.
///
/// This file exists because of a rule the C side states and this shell obeys:
/// **the model never emits English** (`ttp_ui.h`). `ttp_ui_results_view_json`
/// answers `{titleKey: "cup_champs", cupName: "Sunset"}`, never
/// `"Sunset CHAMPS!"` — so the copy table is the SHELL's, and each of the three
/// shells owns its own. The web's live next to the elements they fill
/// (`main.js`'s `TITLE_COPY` / `SUB_COPY` / `NEWGAME_COPY` / `RACES_COPY`, plus
/// a scattering of inline literals); tvOS collects them here so a localisation
/// pass has one file to read.
///
/// Every string below is transcribed from the shipping web display. Where the
/// web composes with a template literal, the same composition happens here —
/// the two screens must tell the same story, and for the standings board they
/// literally do (the same board goes on the wire to the phones).
///
/// PROJECT RULE: no em dashes in user-facing copy. The one below, in
/// `startingIn`, is grandfathered shipped copy transcribed verbatim; it is not
/// a licence to add another.
enum Copy {

    // MARK: - Unknown keys

    /// What an unrecognised model key renders as.
    ///
    /// Deliberately NOT an English fallback and deliberately not empty. A key
    /// this shell has no case for means the C++ grew an answer the Swift screens
    /// do not know about — a real bug, and one whose only symptom is a screen.
    /// `"[cup_champs?]"` is visible in a screenshot; `""` and `"Results"` are
    /// not, and both would let the gap ship. The web can be sloppier here
    /// (`ITEM_LABELS[item] || ''` feeds a tooltip beside a visible icon); on a
    /// TV the label is often the only thing there is.
    private static func unknown(_ key: String) -> String { "[\(key)?]" }

    /// Stands in for a piece of DATA the model should have supplied alongside a
    /// key it did supply — a different bug from an unknown key, so a different
    /// mark. `"?"` is the web's own fallback for a cup with no name.
    static let unknownValue = "?"

    // MARK: - Keyed tables

    /// `cupSlot.racesKey` → the races pill under the cup sticker.
    /// (`RACES_COPY`, `main.js`.)
    static func races(_ key: String, count: Int) -> String {
        switch key {
        case "one": return "1 race"
        case "endless": return "endless"
        case "count": return "\(count) races"
        default: return unknown(key)
        }
    }

    /// `resultsView.titleKey` → the results overlay's header.
    /// (`TITLE_COPY`, `main.js`.)
    static func title(_ key: String, cupName: String?) -> String {
        switch key {
        case "cup_champs": return "\(cupName ?? unknownValue) CHAMPS!"
        case "standings": return "Standings"
        case "results": return "Results"
        default: return unknown(key)
        }
    }

    /// `resultsView.sub.key` → the intermission subtitle. Shown only during a
    /// cup intermission; the podium's CHAMPS header says it all on its own.
    /// (`SUB_COPY`, `main.js`.)
    ///
    /// The two keys differ only in whether the series knows its length: an
    /// endless cup has no "of N" to print, which is why the model spells them
    /// as two keys rather than making the shell test `of != nil`.
    static func sub(_ key: String, cupName: String, race: Int, of: Int?) -> String {
        switch key {
        case "cup_race": return "\(cupName) · Race \(race)"
        case "cup_race_of": return "\(cupName) · Race \(race) of \(of.map(String.init) ?? unknownValue)"
        default: return unknown(key)
        }
    }

    /// `resultsView.newGameKey` → the results overlay's primary button.
    /// (`NEWGAME_COPY`, `main.js`.) Mid-cup it advances the series; at the end
    /// it ends the party.
    static func newGame(_ key: String) -> String {
        switch key {
        case "next_race": return "Next race ▸"
        case "new_game": return "New Game"
        default: return unknown(key)
        }
    }

    // MARK: - Formatters

    /// English ordinal for a place. A direct port of `shared/format.js`'s
    /// `ordinal()`, 11/12/13 exception included — that exception is the whole
    /// reason the function exists, since a naive last-digit rule prints "11st".
    /// Used for both the live place readout and the FINISHED card.
    static func ordinal(_ n: Int) -> String {
        let t = n % 100, u = n % 10
        let suffix: String
        if t >= 11 && t <= 13 { suffix = "th" }
        else if u == 1 { suffix = "st" }
        else if u == 2 { suffix = "nd" }
        else if u == 3 { suffix = "rd" }
        else { suffix = "th" }
        return "\(n)\(suffix)"
    }

    /// The per-cell lap counter, under the place ordinal. (`Stage.js`.)
    static func lap(_ lap: Int, of total: Int) -> String { "Lap \(lap)/\(total)" }

    /// A finish time, one decimal. (`Stage.js`, `main.js`.)
    ///
    /// The web uses `Number.prototype.toFixed(1)`, which `printf` cannot
    /// reproduce exactly — that difference is real enough elsewhere in this tree
    /// that the schematic projection routes through double-conversion's `ToFixed`
    /// for it. It does not matter here: this is a screen string, not a frozen
    /// corpus, and the two spellings can only disagree on an exact half at the
    /// second decimal of a lap clock. `%.1f` is the right tool for a readout.
    static func seconds(_ t: Double) -> String { String(format: "%.1fs", t) }

    /// A cup row's running total. (`main.js`.)
    static func points(_ n: Int) -> String { "\(n) pts" }

    /// What this race added to it. Zero is still printed ("+0") and styled
    /// quiet, so the column never goes ragged.
    static func gained(_ n: Int) -> String { "+\(n)" }

    /// A results/podium name with the AI tag. Bots keep the tag everywhere —
    /// beating them is the story of a short-handed cup.
    static func name(_ name: String, ai: Bool) -> String { ai ? name + cpuSuffix : name }

    /// The countdown banner. `n > 0` is the digit, `0` is GO, anything below is
    /// the banner going away. (`main.js`, driven by
    /// `ttp_race_countdown_tick_json`.)
    static func countdown(_ n: Int) -> String? {
        if n > 0 { return String(n) }
        if n == 0 { return go }
        return nil
    }

    /// The now-playing chip, bottom-left of the race screen.
    ///
    /// This is the CC-BY attribution for the music catalogue, not decoration:
    /// the songs are Kevin MacLeod's under CC-BY and a shell that plays them
    /// owes a visible credit. Do not hide it to clean up the frame.
    static func musicCredit(title: String, artist: String) -> String { "\(title) · \(artist)" }

    /// The long form the web hangs off the link's tooltip. A TV has no hover, so
    /// wherever this lands it has to be somewhere reachable — an info panel, or
    /// the chip itself if there is room.
    static func musicCreditFull(title: String, artist: String, license: String) -> String {
        "\(title) by \(artist) — \(license) (source ↗)"
    }

    // MARK: - Wordmark

    static let wordmarkLine1 = "TINY TRACK"
    static let wordmarkLine2 = "PARTY!"

    // MARK: - Lobby

    /// Hangs under the join ticket for the whole lobby — joining stays possible
    /// until the race starts.
    static let scanPrompt = "Scan the code with your phone!"
    /// An unfilled seat. `ttp_ui_seat_grid_json` pads the grid with these; the
    /// padding is the model's job so three shells cannot pad differently.
    static let openSeat = "Open"
    /// Accessibility labels for the two corner markers on a seat card. They are
    /// mutually exclusive: the host never readies.
    static let host = "Host"
    static let ready = "Ready"
    /// The cup sticker when the host picked Random rather than a cup or a track.
    static let random = "Random"
    /// The cup sticker for the World Tour: one random track per cup, raced in
    /// the cups' difficulty order. (`NAME_COPY`, `main.js`.)
    static let worldTour = "World Tour"

    // MARK: - Info board

    /// The lobby's ⓘ, which is icon-only on screen — this is what a screen
    /// reader announces and what the UI test finds it by.
    static let info = "Info"
    /// The two central legal pages, as their cards' labels. They are the web
    /// footer's own words (`site-foot`), and the URLs they point at are read out
    /// of that footer rather than typed here (`Legal`).
    static let privacy = "Privacy"
    static let imprint = "Imprint"
    /// The attribution board, and the button that opens it. Uppercased at render
    /// like every other sticker button; the word itself matches the web's
    /// /licenses.html title.
    static let licenses = "Licenses"

    // MARK: - Race

    /// The centred card in a player's cell the instant they cross the line. It
    /// is written ONCE and then left alone for the rest of the race.
    static let finished = "FINISHED"
    /// GO is the beat the race actually starts on, not a beat before it.
    static let go = "GO!"
    /// The reconnect card's subtitle, under the dropped player's name and over
    /// their rejoin QR. It takes the same cell slot as the FINISHED card, and
    /// FINISHED wins if a car is somehow both.
    static let disconnected = "Disconnected"

    // MARK: - Pause overlay

    static let paused = "Paused"
    static let continueLabel = "Continue"
    /// Lower-case "game" here and title-case in `newGame("new_game")`: that
    /// difference is in the shipping web copy (a pause-overlay button vs a
    /// results-board button) and is transcribed rather than harmonised, because
    /// harmonising it here would put this shell's screens out of step with the
    /// web's for no gain.
    static let newGameLabel = "New game"

    // MARK: - Results

    /// A car that did not finish inside the race's own time cap.
    static let dnf = "DNF"
    /// The trailing cell of a `joining` row: a seat that arrived mid-race and
    /// races in the next one. It has no time and no points to show.
    static let nextRace = "Next race"
    /// The intermission footer, assembled as `nextUp + trackName + startingIn +
    /// secs + ellipsis` — three literals around two values, exactly as the web
    /// builds it, so the sentence reads the same on both screens.
    static let nextUp = "Next up: "
    static let startingIn = " — starting in "
    static let ellipsis = "…"

    // MARK: - Shared

    /// Appended to every AI name on the results list and the podium.
    static let cpuSuffix = " (CPU)"
}
