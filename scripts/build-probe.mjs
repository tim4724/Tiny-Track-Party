#!/usr/bin/env node
// Configure + build probe_cli, for the three `npm run probe:*` scripts.
//
// They used to each carry the same two cmake commands inline in package.json.
// Beyond the triplication, the configure named no generator, so a fresh
// worktree was pinned to a Make build tree by whichever probe ran first — see
// scripts/lib/native-cmake.mjs.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTarget, configureNative } from './lib/native-cmake.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  configureNative(ROOT);
  buildTarget(ROOT, 'probe_cli');
} catch (err) {
  console.error(`could not build probe_cli: ${err.message}`);
  process.exit(2);
}
