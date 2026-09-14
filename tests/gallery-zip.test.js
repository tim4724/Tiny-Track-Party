// The screens gallery's store-set zip (public/gallery-zip.js). The file goes to a
// store console, so what is pinned is that a real unzip reads it back byte for
// byte, not the header layout.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const url = require('node:url');

const ROOT = path.join(__dirname, '..');

async function build(files) {
  const { zipStored } = await import(url.pathToFileURL(path.join(ROOT, 'public/gallery-zip.js')).href);
  return Buffer.from(await zipStored(files).arrayBuffer());
}

const FILES = [
  { name: '1-race-beach.jpg', data: new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]) },
  { name: '2-race-snow.jpg', data: new Uint8Array(70000).map((_, i) => (i * 31) & 0xff) },
  { name: 'empty.jpg', data: new Uint8Array(0) }
];

test('every entry reads back through the central directory with its CRC', async () => {
  const zip = await build(FILES);
  const eocd = zip.length - 22;
  assert.equal(zip.readUInt32LE(eocd), 0x06054b50, 'no end-of-central-directory record');
  assert.equal(zip.readUInt16LE(eocd + 10), FILES.length);
  let at = zip.readUInt32LE(eocd + 16);
  for (const f of FILES) {
    assert.equal(zip.readUInt32LE(at), 0x02014b50);
    const nameLen = zip.readUInt16LE(at + 28);
    assert.equal(zip.toString('ascii', at + 46, at + 46 + nameLen), f.name);
    const local = zip.readUInt32LE(at + 42);
    assert.equal(zip.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + zip.readUInt16LE(local + 26);
    const data = zip.subarray(start, start + zip.readUInt32LE(at + 24));
    assert.deepEqual(new Uint8Array(data), f.data);
    assert.equal(zip.readUInt32LE(at + 16), zlib.crc32(f.data), `${f.name}: CRC`);
    at += 46 + nameLen;
  }
});

test('the system unzip accepts it', async (t) => {
  try {
    execFileSync('unzip', ['-v'], { stdio: 'ignore' });
  } catch {
    t.skip('no unzip on this machine');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttp-zip-'));
  try {
    const file = path.join(dir, 'store.zip');
    fs.writeFileSync(file, await build(FILES));
    execFileSync('unzip', ['-tq', file], { stdio: 'pipe' });
    execFileSync('unzip', ['-q', file, '-d', path.join(dir, 'out')]);
    for (const f of FILES) {
      assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, 'out', f.name))), f.data);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
