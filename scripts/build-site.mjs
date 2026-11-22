// `npm run build:site`: assembles site/, the static tree every deployed host
// serves through Apache with public/.htaccess — main on Hetzner
// (hetzner-deploy.yml), branch previews in the Dockerfile's httpd image. Local
// dev serves the same routes live from server/index.js.
//
// site/ is public/ with the HTML templates filled in, plus what the dev server
// answers from elsewhere (server/site.js): the partyplug kit under /partyplug/
// and the JSON routes as api/<name>.json. GIT_SHA is the commit the pages
// name in their version label and the screens gallery checks its shots against.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import site from '../server/site.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');
const sha = String(process.env.GIT_SHA || '').trim();

fs.rmSync(OUT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'public'), OUT, {
  recursive: true,
  filter: (src) => path.basename(src) !== '.DS_Store'
});

for (const rel of fs.readdirSync(OUT, { recursive: true })) {
  if (!rel.endsWith('.html')) continue;
  const file = path.join(OUT, rel);
  fs.writeFileSync(file, site.renderHtml(fs.readFileSync(file, 'utf8'), { sha, relayUrl: '' }));
}

// The dev server serves partyplug's top-level .js files and nothing else of it.
fs.mkdirSync(path.join(OUT, 'partyplug'));
for (const name of fs.readdirSync(path.join(ROOT, 'partyplug'))) {
  if (name.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'partyplug', name), path.join(OUT, 'partyplug', name));
}

fs.mkdirSync(path.join(OUT, 'api'));
for (const [route, payload] of Object.entries(site.JSON_ROUTES)) {
  fs.writeFileSync(path.join(OUT, route.slice(1) + '.json'), JSON.stringify(payload()));
}

console.log(`build-site: site/ (${sha ? sha.slice(0, 7) : 'no GIT_SHA'})`);
