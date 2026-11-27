// Put one uploaded Apple TV build in front of the public TestFlight link.
//
//   node shells/tvos/scripts/testflight-public.mjs <bundle id> <version> <build>
//
// Called by release.yml's testflight job once the tvos job has uploaded the
// build, with the tag and the run number the archive was stamped with. Needs
// ASC_KEY_ID and ASC_ISSUER_ID, and the key's .p8 at
// ~/.appstoreconnect/private_keys/AuthKey_<id>.p8, where that job writes it.
//
// WHY THIS EXISTS. An upload alone reaches internal testers only. External
// testers get a build once it is in an external group AND has passed beta app
// review, and neither step has an xcodebuild or altool verb. Both are App Store
// Connect API calls, signed with the same App Manager key the upload uses.
//
// IT WAITS for processing, because a build cannot join a group or be submitted
// until Apple has finished with it, and that takes minutes after the upload
// returns. It does NOT wait for the review: that takes hours, and an approved
// build reaches the link's testers with no further step.
//
// "Public" is the group's name in App Store Connect, verbatim, the way tv:beta
// is the Play track's: the public link belongs to that group, so renaming it in
// the console breaks this step loudly.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const GROUP = 'Public';
const POLL_MS = 30_000;
const PROCESSING_LIMIT_MS = 60 * 60_000;

const [bundleId, version, build] = process.argv.slice(2);
const { ASC_KEY_ID, ASC_ISSUER_ID } = process.env;
if (!bundleId || !version || !build || !ASC_KEY_ID || !ASC_ISSUER_ID) {
  console.error('usage: ASC_KEY_ID=… ASC_ISSUER_ID=… testflight-public.mjs <bundle id> <version> <build>');
  process.exit(2);
}
const key = fs.readFileSync(`${os.homedir()}/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8`);

// A fresh token per request: Apple caps one at 20 minutes, and the wait for
// processing can outlast that.
function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' })}.${b64({
    iss: ASC_ISSUER_ID, iat: now, exp: now + 600, aud: 'appstoreconnect-v1',
  })}`;
  const sig = crypto.sign('sha256', Buffer.from(body), { key, dsaEncoding: 'ieee-p1363' });
  return `${body}.${sig.toString('base64url')}`;
}

async function api(method, path, data) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
    body: data && JSON.stringify({ data }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const app = (await api('GET', `/v1/apps?filter[bundleId]=${bundleId}`)).data
  .find((a) => a.attributes.bundleId === bundleId);
if (!app) throw new Error(`no App Store Connect app for ${bundleId}`);

const group = (await api('GET', `/v1/apps/${app.id}/betaGroups`)).data
  .find((g) => g.attributes.name === GROUP && !g.attributes.isInternalGroup);
if (!group) throw new Error(`no external TestFlight group named "${GROUP}"`);

const query = `/v1/builds?filter[app]=${app.id}&filter[version]=${build}`
  + `&filter[preReleaseVersion.version]=${version}&include=buildBetaDetail`;
const deadline = Date.now() + PROCESSING_LIMIT_MS;
let buildId;
for (;;) {
  const res = await api('GET', query);
  const b = res.data[0];
  const external = res.included?.find((i) => i.type === 'buildBetaDetails')?.attributes.externalBuildState;
  const processing = b?.attributes.processingState;
  console.log(`${version} (${build}): ${processing ?? 'not listed yet'}, external ${external ?? '-'}`);
  if (processing === 'FAILED' || processing === 'INVALID') throw new Error(`build ${processing}`);
  if (external === 'MISSING_EXPORT_COMPLIANCE') {
    throw new Error('export compliance missing: ITSAppUsesNonExemptEncryption left project.yml?');
  }
  if (processing === 'VALID' && external === 'READY_FOR_BETA_SUBMISSION') { buildId = b.id; break; }
  if (Date.now() > deadline) throw new Error('still processing after the limit');
  await new Promise((r) => setTimeout(r, POLL_MS));
}

await api('POST', `/v1/betaGroups/${group.id}/relationships/builds`, [{ type: 'builds', id: buildId }]);
await api('POST', '/v1/betaAppReviewSubmissions', {
  type: 'betaAppReviewSubmissions',
  relationships: { build: { data: { type: 'builds', id: buildId } } },
});
console.log(`${version} (${build}) is in "${GROUP}" and submitted for beta app review: ${group.attributes.publicLink}`);
