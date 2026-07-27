// ttp_session.h — INTERNAL seam between the two halves of the runtime, not an
// ABI: the display shell reads the live Game of a session handle in C++ rather
// than receiving a serialized copy of it back from the shell.
//
// One function, deliberately. Everything else the display needs it gets from
// the Game itself, so the sim ABI in ttp_runtime.h stays the only way anything
// MUTATES a session.
#ifndef TTP_SESSION_H
#define TTP_SESSION_H

namespace ttp {
class Game;
}

// The engine behind a ttp_session_begin handle, or nullptr for an unknown,
// disposed or not-yet-built handle. Never owns: the session outlives the call.
ttp::Game* ttp_session_engine(int handle);

#endif  // TTP_SESSION_H
