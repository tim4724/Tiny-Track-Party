// @ts-check
// What the two apps load, from each tree a server hands out.
//
// From site/ it is only code under names the hosts cache for good: the rule is
// public/.htaccess's immutable <If>, the names are scripts/build-site.mjs's. A
// script tag or a fetch that goes around the build is refetched on every load
// and can pair with an older bundle, which is what the names exist to rule out.
//
// From the sources the apps still boot. The rest of the suite runs against
// site/, and the bundler resolves imports a browser cannot, so this is the one
// place that would notice `npm run dev` breaking.
const fs = require('fs');
const path = require('path');
const { test, expect, openDisplay } = require('./helpers');

const HTACCESS = fs.readFileSync(path.join(__dirname, '..', '..', 'public', '.htaccess'), 'utf8');
const IMMUTABLE = new RegExp(/^<If "%\{REQUEST_URI\} =~ m#(.+)#">\n +Header set Cache-Control "[^"]*immutable"$/m.exec(HTACCESS)[1]);

// Opens the display on `baseURL` and joins a phone. Resolves to the path of
// every code file the two asked for, from their first request on (which is why
// this is not joinController).
async function bootBoth(browser, baseURL) {
  const code = [];
  const open = async (options) => {
    const page = await (await browser.newContext({ baseURL, ...options })).newPage();
    page.on('request', (r) => {
      const { pathname } = new URL(r.url());
      if (/\.(js|mjs|css|wasm|filamat)$/.test(pathname)) code.push(pathname);
    });
    return page;
  };
  const display = await open({});
  await openDisplay(display);
  const roomCode = await display.evaluate(() => window.__net.roomCode);
  const phone = await open({ viewport: { width: 844, height: 390 } });
  await phone.goto(`/${roomCode}`);
  await phone.fill('#name-input', 'Alice');
  await phone.click('#join-btn');
  await phone.waitForSelector('#name.hidden', { state: 'attached', timeout: 15000 });
  return code;
}

function expectLoaded(code, parts) {
  for (const part of parts) expect(code.some((p) => part.test(p)), String(part)).toBe(true);
}

test('from site/, the display and the phone load only content-named code', async ({ browser, baseURL }) => {
  const code = await bootBoth(browser, baseURL);
  expectLoaded(code, [/^\/bundle\/display\./, /^\/bundle\/controller\./, /\/ttp_runtime\.mjs$/, /\.wasm$/, /\.filamat$/]);
  expect(code.filter((p) => !IMMUTABLE.test(p))).toEqual([]);
});

test('from the sources, the display and the phone still boot', async ({ browser }, testInfo) => {
  const code = await bootBoth(browser, testInfo.config.metadata.sourceURL);
  expectLoaded(code, [/^\/display\/main\.js$/, /^\/controller\/main\.js$/, /^\/display\/engine\/native\/ttp_runtime\.mjs$/]);
  expect(code.filter((p) => p.startsWith('/bundle/'))).toEqual([]);
});
