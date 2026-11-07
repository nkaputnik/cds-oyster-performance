const test = require("node:test");
const assert = require("node:assert/strict");
const { planCloudRuns, checkState } = require("../bench/cloud/run.js");
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const { homedir } = require('node:os');
const { resolve } = require('node:path');
const { runCloudBenchmark } = require('../bench/cloud/run.js');
const settings = { suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1, filter: '^action/SmallRows/native-empty/direct' };
const internalRoot = 'http://provider.apps.internal:8080';
const routerRoot = 'https://provider.cfapps.eu12.hana.ondemand.com';
async function createScratch() {
  const parent = resolve(homedir(), 'git/clean-room/cds-oyster-performance-tests');
  await mkdir(parent, { recursive: true });
  return mkdtemp(resolve(parent, 'network-test-'));
}

test('cloud runner defaults to internal CF networking and records the selected transport', async t => {
  const reportDir = await createScratch();
  t.after(() => rm(reportDir, { recursive: true, force: true }));
  const auth = { assertProvider: url => assert.equal(url, internalRoot), ensureWindow: async () => { throw new Error('Stop before fixture access'); } };
  const result = await runCloudBenchmark(settings, { baseUrl: internalRoot, auth, reportDir });
  assert.equal(result.error, 'Stop before fixture access');
  assert.deepEqual(result.manifest.environment.network, { mode: 'container-to-container', protocol: 'http:', hostname: 'provider.apps.internal', port: '8080', tls: false, path: 'CF container-to-container' });
});

test('explicit cf-router environment uses existing tenant OAuth and records router/TLS costs', async t => {
  const reportDir = await createScratch();
  t.after(() => rm(reportDir, { recursive: true, force: true }));
  const original = Object.fromEntries(['VCAP_SERVICES', 'BENCHMARK_SUBDOMAIN', 'BENCHMARK_TENANT_ID', 'BENCHMARK_NETWORK_PATH'].map(key => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.VCAP_SERVICES = JSON.stringify({ xsuaa: [{ credentials: { url: 'https://provider.authentication.example.com', uaadomain: 'authentication.example.com', clientid: 'runner', clientsecret: 'binding-secret', xsappname: 'benchmark' } }] });
  process.env.BENCHMARK_SUBDOMAIN = 'subscriber'; process.env.BENCHMARK_TENANT_ID = 'tenant-a'; process.env.BENCHMARK_NETWORK_PATH = 'cf-router';
  let requests = 0;
  const claims = { iss: 'https://subscriber.authentication.example.com/oauth/token', zid: 'tenant-a', aud: ['benchmark'], scope: ['BenchmarkRunner', 'BenchmarkRecorder', 'BenchmarkAdministrator'].map(scope => 'benchmark.' + scope), exp: Date.now() / 1000 + 3600 };
  const token = Buffer.from('{}').toString('base64url') + '.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.test-signature';
  t.mock.method(global, 'fetch', async (url, options) => {
    requests++; assert.equal(url, claims.iss); assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ access_token: token, token_type: 'bearer' }), { headers: { 'content-type': 'application/json' } });
  });
  const result = await runCloudBenchmark(settings, { baseUrl: routerRoot, reportDir, adapter: { state: async () => { throw new Error('Stop before benchmark setup'); } } });
  assert.equal(result.error, 'Stop before benchmark setup'); assert.equal(requests, 1);
  assert.deepEqual(result.manifest.environment.network, { mode: 'cf-router', protocol: 'https:', hostname: 'provider.cfapps.eu12.hana.ondemand.com', port: '443', tls: true, path: 'CF router' });
  assert.equal(result.manifest.environment.authenticationRenewals.length, 1);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test('cloud runner rejects invalid network selections and contradictory roots before auth forwarding', async t => {
  const reportDir = await createScratch();
  t.after(() => rm(reportDir, { recursive: true, force: true }));
  let forwarded = 0;
  const auth = { assertProvider: () => { forwarded++; }, ensureWindow: async () => { forwarded++; throw new Error('Unexpected auth access'); } };
  for (const [networkPath, baseUrl] of [
    ['unknown', internalRoot], ['', internalRoot], ['container-to-container', routerRoot],
    ['cf-router', internalRoot], ['cf-router', 'http://provider.cfapps.eu12.hana.ondemand.com'],
    ['cf-router', 'https://attacker.example.com'], ['cf-router', routerRoot + '/benchmark'],
    ['cf-router', routerRoot + '?secret=value'], ['cf-router', routerRoot + '#fragment'],
    ['cf-router', 'https://user:password@provider.cfapps.eu12.hana.ondemand.com'],
    ['container-to-container', internalRoot + '/benchmark'], ['container-to-container', 'ftp://provider.apps.internal'],
  ]) await assert.rejects(runCloudBenchmark(settings, { baseUrl, networkPath, auth, reportDir }), /network path|provider root/i);
  assert.equal(forwarded, 0);
});
test('campaign state rejects restart, blocked extension, changed versions and lost or overlapping lease', () => {
  const baseline = { tenant: 'a', instance: { ID: 'instance' }, engine: 'oyster', extensionHealthy: true, extensionFingerprint: 'hash', versions: { oyster: '1' }, limits: {}, lease: { active: true, owner: 'owner' } };
  assert.equal(checkState(baseline, baseline, 'owner'), baseline);
  for (const changes of [{ instance: { ID: 'restart' } }, { extensionHealthy: false }, { extensionFingerprint: 'changed' }, { versions: { oyster: '2' } }, { lease: { active: false, owner: 'owner' } }, { lease: { active: true, owner: 'other' } }]) assert.throws(() => checkState({ ...baseline, ...changes }, baseline, 'owner'));
});
test('bounded pilot covers actions, lookup, accepted/rejected writes, extension points, all READ shapes and mixed traffic', () => {
  const runs = planCloudRuns({ suite: 'short', repetitions: 1, seed: 42, pilot: true });
  assert.ok(runs.length < 102);
  for (const mode of ['native-empty', 'wasm-empty', 'native-validate', 'wasm-validate']) assert.ok(runs.some(run => run.scenario.mode === mode));
  for (const operation of ['create', 'update']) for (const outcome of ['accepted', 'rejected']) assert.ok(runs.some(run => run.scenario.operation === operation && run.scenario.validationOutcome === outcome));
  for (const shape of ['page', 'key', 'range', 'non-indexed', 'offset']) assert.ok(runs.some(run => run.scenario.queryShape === shape && run.scenario.operation === 'read'));
  assert.ok(runs.some(run => run.scenario.hook)); assert.ok(runs.some(run => run.scenario.lookupPattern)); assert.ok(runs.some(run => run.scenario.mixed));
});
test("cloud campaigns retain complete presets and adjacent counterbalanced pairs", () => {
  const short = planCloudRuns({ suite: "short", repetitions: 1, seed: 42 });
  const long = planCloudRuns({ suite: "long", repetitions: 3, seed: 42 });
  assert.equal(short.length, 102); assert.equal(long.length, 345);
  assert.equal(short.some(run => run.scenario.mode === "cap-baseline"), false);
  for (let repetition = 1; repetition <= 3; repetition++) {
    const group = long.filter(run => run.repetition === repetition);
    assert.deepEqual(group.map(run => run.load.value), [...group.map(run => run.load.value)].sort((a,b) => a-b));
    for (const [index, run] of group.entries()) if (run.scenario.mode.startsWith("native-") && run.pairID) {
      const other = group.findIndex(candidate => candidate.pairID === run.pairID && candidate.scenario.mode.startsWith("wasm-"));
      assert.equal(Math.abs(other-index), 1);
      assert.equal(index < other, repetition % 2 === 1);
    }
  }
});
