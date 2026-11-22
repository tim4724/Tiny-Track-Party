// `npm run build:site`: assembles site/, the static tree every deployed host
// serves through Apache with public/.htaccess — main on Hetzner
// (hetzner-deploy.yml), branch previews in the Dockerfile's httpd image. Local
// dev serves the same routes live from server/index.js.
//
// site/ is public/ with the HTML templates filled in, plus what the dev server
// answers from elsewhere (server/site.js): the partyplug kit under /partyplug/
// and the JSON routes as api/<name>.json. GIT_SHA is the commit the pages
// name in their version label and the screens gallery checks its shots against.
//
// The code the two apps load is named by its content here, and public/.htaccess
// caches those names for good:
//   - the engine's folder, display/engine/<hash>/ (display/engine/dir.js is
//     rewritten to name it, for the galleries' unbundled modules too);
//   - one esbuild bundle per app plus the chunks they share or load late, flat
//     in bundle/ because shared/assetUrl.js resolves against its own location,
//     which has to stay one level below the root;
//   - the classic scripts and stylesheets their pages name, each minified
//     beside its source so a relative url() still holds.
// The galleries, the trailer editor and the licenses page keep loading the
// sources, which is why those stay in the tree.
//
// RELAY_URL is the E2E suite's, which runs against this tree
// (playwright.config.js); no deploy sets it.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import esbuild from 'esbuild';

import site from '../server/site.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');
const APPS = ['display', 'controller'];
const sha = String(process.env.GIT_SHA || '').trim();
const relayUrl = String(process.env.RELAY_URL || '').trim();

// esbuild's own [hash] is eight of A-Z2-7; this is eight of 0-9A-F. The
// immutable rule in public/.htaccess matches both.
const hashOf = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const part of parts) h.update(part);
  return h.digest('hex').slice(0, 8).toUpperCase();
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, {
  recursive: true,
  filter: (src) => path.basename(src) !== '.DS_Store'
});

// The dev server serves partyplug's top-level .js files and nothing else of it.
fs.mkdirSync(path.join(OUT, 'partyplug'));
for (const name of fs.readdirSync(path.join(ROOT, 'partyplug'))) {
  if (name.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'partyplug', name), path.join(OUT, 'partyplug', name));
}

const engineRoot = path.join(OUT, 'display', 'engine');
const engineFiles = fs.readdirSync(path.join(engineRoot, 'native')).sort();
const engine = hashOf(...engineFiles.flatMap((name) => [name, fs.readFileSync(path.join(engineRoot, 'native', name))]));
fs.renameSync(path.join(engineRoot, 'native'), path.join(engineRoot, engine));
fs.writeFileSync(path.join(engineRoot, 'dir.js'), `export const ENGINE_DIR = '${engine}';\n`);

// Each app's main.js and everything it imports. es2022 is what the sources
// are written in, so minifying adds no newer syntax; keepNames because the
// E2E suite tells the adapters apart by class name.
const { metafile } = await esbuild.build({
  absWorkingDir: OUT,
  entryPoints: Object.fromEntries(APPS.map((app) => [app, `${app}/main.js`])),
  outdir: 'bundle',
  entryNames: '[name].[hash]',
  chunkNames: 'chunk.[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  keepNames: true,
  sourcemap: true,
  metafile: true,
  logLevel: 'warning'
});
// Source URL to the content-named URL that replaces it in a page.
const hashed = new Map();
for (const [out, { entryPoint }] of Object.entries(metafile.outputs)) {
  if (entryPoint) hashed.set('/' + entryPoint, '/' + out);
}

// A script or stylesheet a page names: the bundle if it is an app's main.js,
// else a minified copy beside the source. Scripts keep their names, as the
// pages' other scripts reach them as globals.
function hashedUrl(url) {
  if (!hashed.has(url)) {
    const css = url.endsWith('.css');
    const { code } = esbuild.transformSync(fs.readFileSync(path.join(OUT, url), 'utf8'), css
      ? { loader: 'css', minify: true }
      : { minifyWhitespace: true, minifySyntax: true });
    const to = url.replace(/\.(js|css)$/, `.${hashOf(code)}.$1`);
    fs.writeFileSync(path.join(OUT, to), code);
    hashed.set(url, to);
  }
  return hashed.get(url);
}
const CODE_REF = /(\b(?:src|href)=")(\/[^"?]+\.(?:js|css))(?:\?[^"]*)?(")/g;

for (const rel of fs.readdirSync(OUT, { recursive: true })) {
  if (!rel.endsWith('.html')) continue;
  const file = path.join(OUT, rel);
  let html = site.renderHtml(fs.readFileSync(file, 'utf8'), { sha, relayUrl })
    .replaceAll('/display/engine/native/', `/display/engine/${engine}/`);
  if (APPS.some((app) => rel === path.join(app, 'index.html'))) {
    html = html.replace(CODE_REF, (_, pre, url, post) => pre + hashedUrl(url) + post);
  }
  fs.writeFileSync(file, html);
}

fs.mkdirSync(path.join(OUT, 'api'));
for (const [route, payload] of Object.entries(site.JSON_ROUTES)) {
  fs.writeFileSync(path.join(OUT, route.slice(1) + '.json'), JSON.stringify(payload()));
}

console.log(`build-site: site/ (${sha ? sha.slice(0, 7) : 'no GIT_SHA'})`);
