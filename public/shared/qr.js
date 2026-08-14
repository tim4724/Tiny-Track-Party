// The join-code QR encoder, in the browser: drawing its own join code is not
// something a display should need a server for. Every shell encodes locally and
// only the module bitmap is per-platform — the decision, and the other two
// shells' encoders, are in docs/native-port/shells.md §7.
//
// Node imports this directly, so keep it dependency-free.
import qrcode from './qrcode-generator.js';

// EC level L, 1-module quiet zone. Returns { size, modules } where
// modules[row * size + col] is 1 for a dark module, or null on failure so callers
// degrade to a blank QR rather than a broken screen.
export function buildQRMatrix(text) {
  try {
    const qr = qrcode(0, 'L');   // typeNumber 0 = smallest version that fits
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const quiet = 1;
    const size = count + quiet * 2;
    const modules = new Array(size * size).fill(0);
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) modules[(row + quiet) * size + (col + quiet)] = 1;
      }
    }
    return { size, modules };
  } catch (e) {
    console.warn('QR encode failed', e);
    return null;
  }
}
