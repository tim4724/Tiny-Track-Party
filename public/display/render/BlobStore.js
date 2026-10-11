// Bytes kept between RUNS, in IndexedDB, under names the ENGINE chooses.
//
// FOUR PRIMITIVES AND NO POLICY. This lists, reads, writes and deletes; it does
// not know what a blob contains, what it is called, when it stops being valid or
// which one to throw away. Those are rules rather than platform facts, and they
// live in `libttp-runtime/ttp/blobstore.h` where they are stated once for every
// shell and pinned by the `abi` ctest — because the answers are not equally
// visible when wrong. A bad eviction wastes disk. A bad INVALIDATION serves a
// stale blob forever, across reloads, with nothing on screen to say so.
//
// It knows nothing about WHAT it is storing either: `ttp_display.h`'s walk
// decides what to read, write and drop and hands over a name.
//
// GENERATION IS THE INVALIDATION and it is this shell's one real contribution.
// The web's is `BUILD_STAMP.json`'s `sourceHash` — a hash over every file that
// fed the wasm — which is a better identity than either TV shell can offer:
// Android has to use the APK's install time and tvOS its bundle version, both of
// which describe a build rather than being derived from one. The engine folds it
// into the NAME, so a rebuilt runtime cannot name the old one's blob at all.
//
// NOTHING HERE IS LOAD-BEARING. A miss, a blocked database (private browsing, a
// storage-cleared origin), a quota refusal and a failed delete all mean the same
// thing: compute it again. Every road out is a null or a no-op.

import { assetUrl } from '../../shared/assetUrl.js';

// `-bake` is the name of the one store there is, kept so the databases already
// on players' machines stay reachable rather than orphaned.
const DB_NAME = 'ttp-blobs-bake';
const DB_VERSION = 1;

/**
 * What identifies the runtime that produced (or would produce) these bytes.
 *
 * Fetched once per page load. A stamp that cannot be read is NOT "any
 * identity": an empty generation would still name a blob and every build would
 * then share it, so the fallback is a value only this page load can match and
 * the cache never hits.
 */
let generationPromise = null;
function generation() {
  generationPromise ??= fetch(assetUrl('/display/engine/native/BUILD_STAMP.json'))
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => (typeof j?.sourceHash === 'string' && j.sourceHash) || null)
    .catch(() => null)
    .then((hash) => hash || `unknown-${Date.now()}-${Math.random()}`);
  return generationPromise;
}

function open() {
  return new Promise((resolve) => {
    let req;
    // Private modes and storage-blocked origins throw from open() itself rather
    // than firing onerror, so the call is inside the try as well as its handlers.
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function tx(db, mode, run) {
  return new Promise((resolve) => {
    let os;
    try {
      os = db.transaction('blobs', mode).objectStore('blobs');
    } catch {
      resolve(null);
      return;
    }
    const req = run(os);
    if (!req) { resolve(null); return; }
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

export class BlobStore {
  constructor() {
    this._db = open();
  }

  /** What identifies this runtime. */
  generation() { return generation(); }

  /**
   * Everything held, as the walk's `entries` argument.
   *
   * `usedMs` is this shell's clock and is never compared against anything but its
   * siblings — an epoch, an uptime and a file mtime all sort the same way.
   */
  async entriesJson() {
    const db = await this._db;
    if (!db) return '[]';
    // Both reads in ONE transaction: a write landing between two would shift
    // getAll's key order against getAllKeys, pairing a name with a neighbour's
    // usedMs.
    const pair = await new Promise((resolve) => {
      let os;
      try {
        os = db.transaction('blobs', 'readonly').objectStore('blobs');
      } catch {
        resolve(null);
        return;
      }
      const keys = os.getAllKeys();
      const rows = os.getAll();
      let left = 2;
      const done = () => { if (--left === 0) resolve([keys.result, rows.result]); };
      keys.onsuccess = rows.onsuccess = done;
      keys.onerror = rows.onerror = () => resolve(null);
    });
    if (!pair) return '[]';
    const [names, rows] = pair;
    return JSON.stringify(names.map((name, i) => ({
      name: String(name), usedMs: rows[i]?.usedMs || 0
    })));
  }

  /** The blob's bytes, or null for a miss. Touches it, so eviction sees it used. */
  async read(name) {
    const db = await this._db;
    if (!db) return null;
    const row = await tx(db, 'readonly', (s) => s.get(name));
    if (!row?.bytes) return null;
    await tx(db, 'readwrite', (s) => s.put({ bytes: row.bytes, usedMs: Date.now() }, name));
    return row.bytes;
  }

  /**
   * Store bytes under `name`.
   *
   * There is no half-written blob to guard against the way a file needs one: a
   * put is atomic, so a reload mid-write finds the old value or none.
   */
  async write(name, bytes) {
    const db = await this._db;
    if (!db) return;
    await tx(db, 'readwrite', (s) => s.put({ bytes, usedMs: Date.now() }, name));
  }

  /** Throw one away. A delete that fails is not an error; the plan repeats it. */
  async delete(name) {
    const db = await this._db;
    if (!db) return;
    await tx(db, 'readwrite', (s) => s.delete(name));
  }
}
