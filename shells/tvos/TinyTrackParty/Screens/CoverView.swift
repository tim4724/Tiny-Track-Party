import SwiftUI

/// The boot cover — the splash, and the one board that is NOT a screen.
///
/// The lobby and the race are chrome over a live 3D view. Until that view has
/// put a frame on the panel they are chrome over nothing, and revealing them
/// there is the "board first, track a beat later" flash. This holds over them
/// until it has. WHICH board owes one is `ttp_ui_cover`'s answer, arriving as
/// `GameState.cover`; nothing here decides it, and welcome is exempt because it
/// stands on the paper diorama rather than on the 3D.
///
/// **NOTHING HERE MOVES, and that is a hard rule rather than a style choice.**
/// This is a full-screen overlay over a 4K Metal surface, up at exactly the
/// moment the renderer is busiest — standing a scene up. An animated overlay of
/// that shape is what cost this box 60 -> 7 fps through the GO beat
/// (`CountdownView`'s `.drawingGroup()` note), and a spinner is the single worst
/// thing that could go here: it would compete for the very frames it is waiting
/// on, and make the wait longer to advertise that there is one.
struct CoverView: View {

    /// `GameState.cover` — "none" | "boot".
    let cover: String

    var body: some View {
        if cover == "boot" {
            ZStack {
                // Opaque, and the app's own paper rather than a clear layer: the
                // whole job is to not depend on whatever is behind it having
                // drawn yet.
                Tokens.paper.ignoresSafeArea()
                Wordmark()
            }
            .allowsHitTesting(false)
        }
    }
}
