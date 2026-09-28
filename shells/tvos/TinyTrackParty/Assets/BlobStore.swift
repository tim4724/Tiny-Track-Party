import Foundation

/// Bytes kept between runs, in a directory, under names the ENGINE chooses.
///
/// FOUR PRIMITIVES AND NO POLICY. This lists, reads, writes and deletes; it does
/// not know what a blob contains, what it is called, when it stops being valid
/// or which one to throw away. Those are rules rather than platform facts, and
/// they live in `libttp-runtime/ttp/blobstore.h` where they are stated once for
/// every shell and pinned by the `abi` ctest — because the answers are not
/// equally visible when wrong. A bad eviction wastes disk. A bad INVALIDATION
/// serves a stale blob forever, across restarts, with nothing on screen to say
/// so.
///
/// It knows nothing about what it is storing either. `ttp_display.h`'s walk
/// decides what to read, what to keep and what to drop, and hands over a name;
/// `ttp_display_blob_stores` says which kinds exist. A third kind needs no Swift.
///
/// **`generation` is this shell's one real contribution.** The engine folds it
/// into the NAME, so a new binary cannot name the old one's file at all — which
/// is what makes a stale blob unreachable rather than merely rejected. Android
/// uses the APK's install time; the web uses its BUILD_STAMP hash; here it is
/// the bundle's build number plus the executable's own mtime, because a
/// developer rebuild keeps one version string across many edits and the mtime
/// moves whether the version did or not.
///
/// NOTHING HERE IS LOAD-BEARING. A miss, a short read, a corrupt blob, a full
/// disk and a failed delete all mean the same thing: compute it again.
final class BlobStore {

    private let dir: URL?
    let generation: String

    init(store: String, generation: String) {
        self.generation = generation
        // CACHES, not Application Support: this is derived data the app can
        // rebuild at any time, and the system is entitled to reclaim it under
        // pressure — which is exactly the contract a cache wants. On tvOS that
        // matters more than on a phone, where storage is scarce by design.
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
        guard let base = caches?.appendingPathComponent("ttp-blobs/\(store)", isDirectory: true) else {
            dir = nil
            return
        }
        do {
            try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
            dir = base
        } catch {
            print("[ttp] no \(store) blob directory; nothing will be cached: \(error)")
            dir = nil
        }
    }

    /// Everything held, as the walk's `entries` argument.
    ///
    /// `usedMs` is this shell's clock and is never compared against anything but
    /// its siblings — an epoch, an uptime and a file mtime all sort the same way.
    func entriesJSON() -> String {
        guard let dir else { return "[]" }
        let names = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        var entries: [[String: Any]] = []
        for url in names {
            // A `.part` is a write that died between its temp file and its
            // rename, so it is junk rather than a blob: no plan can ever name
            // it, but it WOULD count towards the cap, and evicting a real blob
            // to make room for a corpse is the one way this could cost
            // something. Dropped on sight.
            if url.lastPathComponent.hasSuffix(".part") {
                try? FileManager.default.removeItem(at: url)
                continue
            }
            let stamp = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?
                .contentModificationDate?.timeIntervalSince1970 ?? 0
            entries.append(["name": url.lastPathComponent, "usedMs": stamp * 1000])
        }
        return TTP.json(entries)
    }

    /// The blob's bytes, or nil for a miss. Touches it, so eviction sees it used.
    func read(_ name: String) -> Data? {
        guard let dir else { return nil }
        let url = dir.appendingPathComponent(name)
        guard let data = try? Data(contentsOf: url) else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return data
    }

    /// Store bytes under `name`, through a temporary — a half-written blob that
    /// a crash leaves behind must not be read back as a whole one. The engine
    /// would refuse it on its length checks, but only after paying to find out.
    func write(_ name: String, _ bytes: Data) {
        guard let dir else { return }
        let tmp = dir.appendingPathComponent("\(name).part")
        let dst = dir.appendingPathComponent(name)
        do {
            try bytes.write(to: tmp, options: .atomic)
            try? FileManager.default.removeItem(at: dst)
            try FileManager.default.moveItem(at: tmp, to: dst)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            print("[ttp] could not store blob \(name): \(error)")
        }
    }

    /// Throw one away. A delete that fails is not an error; the plan repeats it.
    func delete(_ name: String) {
        guard let dir else { return }
        try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
    }
}

/// One `BlobStore` per store the ENGINE says it has.
///
/// The names are asked for rather than typed, which is the point: this shell
/// does not know that a bake or a mask exists, only that the engine keeps some
/// kinds of derived bytes and that each kind wants its own directory.
final class BlobStores {

    private let stores: [(name: String, store: BlobStore)]

    init() {
        // What identifies this binary. Shared by every store, because it
        // describes the builder rather than the built.
        let info = Bundle.main.infoDictionary
        let version = (info?["CFBundleVersion"] as? String) ?? "0"
        let exe = Bundle.main.executableURL
        let mtime = (try? exe?.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate?.timeIntervalSince1970 ?? 0
        let generation = "\(version)-\(Int(mtime))"
        stores = TTP.arr(ttp_display_blob_stores()).compactMap { $0 as? String }
            .map { ($0, BlobStore(store: $0, generation: generation)) }
    }

    /// Perform something for each store, with the name the engine calls it.
    func forEach(_ action: (BlobStore, String) -> Void) {
        for entry in stores { action(entry.store, entry.name) }
    }
}
