import Foundation

/// The marshalling rules `native/runtime/ttp_abi.h` states, in one place.
///
/// Every one of these is a rule the C side already documents; none of them is a
/// decision this shell gets to take. They are here so that no call site has to
/// remember them, because each has a failure mode that is silent:
///
/// - **A returned `const char*` points into per-handle scratch** and is valid
///   only until the next `ttp_*` call on that handle. Reading it later gives
///   whatever the next call wrote. `TTP.str` copies at the call site.
/// - **Truth is non-zero, and the exceptions are named at their declaration.**
///   Handles are the value or 0; every query and every "did it apply" mutator
///   answers 1 for yes. Three are neither: `ttp_display_frame`'s 0 is a
///   legitimate pace skip, `ttp_display_cell_rects` returns a COUNT, and
///   `ttp_car_finished` adds -1 for an unknown car. The display trio's old
///   exit-status polarity (0 = success) was flipped 2026-07-31, so there is no
///   OUTCOME family left to remember — but a shell ported from a revision that
///   had one is inverting those checks.
/// - **An identity crosses as a JSON SCALAR inside a string.** `"3"` and
///   `"\"3\""` are different players. Absent is `nil`; `"null"` is not the same
///   thing as absent for `ttp_net_norm_index_json`, which is a frozen quirk, not
///   a bug (see `EngineIdentity`).
/// - **Returned JSON is canonical (sorted keys) except from `ttp_ui.h` and
///   `ttp_net.h`**, which emit the model's own key order. Nothing here may
///   depend on either — the wire re-sorts everything anyway.
enum TTP {

    // MARK: - Strings

    /// Copy a scratch `const char*` before the next ABI call can overwrite it.
    /// `nil` and the empty string both come back as `nil`, because every ABI
    /// here spells "no answer" one of those two ways and no caller distinguishes
    /// them.
    static func str(_ p: UnsafePointer<CChar>?) -> String? {
        guard let p else { return nil }
        let s = String(cString: p)
        return s.isEmpty ? nil : s
    }

    /// Same, for the calls whose empty answer is meaningful (an empty array, an
    /// empty name).
    static func strOrEmpty(_ p: UnsafePointer<CChar>?) -> String {
        guard let p else { return "" }
        return String(cString: p)
    }

    // MARK: - JSON

    /// Parse a JSON answer into a dictionary. Returns `[:]` rather than throwing:
    /// every JSON-returning export in this ABI either answers or answers emptily
    /// (`ttp_abi.h`'s absent-singleton rule), so a parse failure here means the
    /// C side was never called, and a shell that crashed on it would turn a
    /// no-op into a black screen.
    static func obj(_ p: UnsafePointer<CChar>?) -> [String: Any] {
        obj(str(p) ?? "")
    }

    /// Same, for an answer that has already been copied out of the scratch
    /// buffer. The perf readout is DRAWN and LOGGED from one call, so it crosses
    /// as a String once — asking twice would fold two different windows and put
    /// a screenshot and a benched line at odds.
    static func obj(_ text: String) -> [String: Any] {
        guard let data = text.data(using: .utf8),
              let v = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return [:] }
        return v
    }

    /// Parse a JSON array answer.
    static func arr(_ p: UnsafePointer<CChar>?) -> [Any] {
        guard let text = str(p), let data = text.data(using: .utf8),
              let v = try? JSONSerialization.jsonObject(with: data) as? [Any]
        else { return [] }
        return v
    }

    /// Encode a value for an ABI argument. Sorted keys so a payload the C side
    /// logs or hashes reads the same twice; `withoutEscapingSlashes` because a
    /// URL inside a room snapshot has no business becoming `https:\/\/`.
    static func json(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(
                withJSONObject: value,
                options: [.sortedKeys, .withoutEscapingSlashes])
        else { return "null" }
        return String(data: data, encoding: .utf8) ?? "null"
    }

    // MARK: - Bytes

    /// Hand a buffer to an ABI that takes `(const uint8_t*, uint32_t)`. The C
    /// side copies before returning in every case, so the pointer does not have
    /// to outlive the call.
    @discardableResult
    static func withBytes<R>(_ data: Data, _ body: (UnsafePointer<UInt8>, UInt32) -> R) -> R {
        data.withUnsafeBytes { raw in
            let base = raw.bindMemory(to: UInt8.self).baseAddress
            // An empty Data has a nil base address; the ABIs accept (null, 0).
            return body(base ?? UnsafePointer(bitPattern: 1)!, UInt32(data.count))
        }
    }
}

/// A player identity as the engine spells it: a **JSON scalar**, not a string.
///
/// This type exists because the difference is invisible and load-bearing. Seat
/// ids arrive from the relay as either JSON numbers or JSON strings depending on
/// how a phone joined, and `"3"` (the number three) and `"\"3\""` (the string
/// "3") are two different players to `ttp::parse_scalar_id`. A Swift `String`
/// holding `3` would be encoded as the latter by any ordinary JSON call and
/// silently address the wrong seat.
struct EngineIdentity: Hashable, CustomStringConvertible {
    /// The JSON text, exactly as it crosses the ABI.
    let json: String

    private init(json: String) { self.json = json }

    /// From whatever the relay handed us — already JSON, so pass it through.
    static func raw(_ json: String) -> EngineIdentity { EngineIdentity(json: json) }

    static func number(_ n: Int) -> EngineIdentity { EngineIdentity(json: String(n)) }

    static func string(_ s: String) -> EngineIdentity {
        EngineIdentity(json: TTP.json([s]).dropFirst().dropLast().description)
    }

    /// Rebuild from a decoded JSON value (what you get back out of
    /// `JSONSerialization` when reading a roster).
    static func from(_ any: Any?) -> EngineIdentity? {
        switch any {
        case let n as Int: return .number(n)
        case let n as NSNumber: return .raw(TTP.json([n]).dropFirst().dropLast().description)
        case let s as String: return .string(s)
        default: return nil
        }
    }

    /// For display and for dictionary keys on the Swift side only — never for an
    /// ABI argument.
    var description: String { json.hasPrefix("\"") ? String(json.dropFirst().dropLast()) : json }
}
