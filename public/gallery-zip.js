// A zip of already-compressed files, for the screens gallery's store download.
//
// STORED entries only (no deflate): the payload is JPEG, which deflate cannot
// shrink, and storing is what keeps this a few dozen lines instead of a
// dependency the CSP would have to admit. The format is PKWARE's APPNOTE.TXT:
// a local header before each file, a central directory after them, and the
// end-of-central-directory record last.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {{name: string, data: Uint8Array}[]} files  names are ASCII
 * @returns {Blob} application/zip
 */
export function zipStored(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);   // local file header
    local.setUint16(4, 20, true);           // version needed: 2.0
    local.setUint16(8, 0, true);            // method: stored
    local.setUint16(12, 0x21, true);        // date: 1980-01-01 (no clock in the bytes)
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true); // compressed size
    local.setUint32(22, data.length, true); // uncompressed size
    local.setUint16(26, nameBytes.length, true);
    parts.push(local, nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);   // central directory header
    entry.setUint16(4, 20, true);           // version made by
    entry.setUint16(6, 20, true);           // version needed
    entry.setUint16(14, 0x21, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);      // where the local header is
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);       // end of central directory
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}
