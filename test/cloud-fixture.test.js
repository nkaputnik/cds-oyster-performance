const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { mkdir, mkdtemp, rm, writeFile, readFile, readdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { homedir } = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const cds = require('@sap/cds');
const { DatabaseSync } = require('node:sqlite');
const { scenario } = require('../bench/scenarios.js');
const { requestFor } = require('../bench/requests.js');

const root = resolve(__dirname, '..');
const scratch = resolve(homedir(), 'git/clean-room/oyster-btp-implementation-20261106');
const names = ['SmallRows', 'LargeRows', 'WriteRows', 'LookupRows', 'SideEffectRows'];
const seed = [{ ID: 11, groupNo: 7, value: 2, text: 'a' }, { ID: 37, groupNo: 3, value: 8, text: 'b' }, { ID: 99, groupNo: 7, value: 4, text: 'c' }];
const auth = (user = 'admin') => ({ authorization: 'Basic ' + Buffer.from(user + ':').toString('base64') });
const digest = value => createHash('sha256').update(value).digest('hex');
let directory, database, dataRoot, server, extensionID;
function sql(callback, tenant = 'tenant-a') {
  const db = new DatabaseSync(database.replace('.sqlite', '-' + tenant + '.sqlite'));
  try { return callback(db); } finally { db.close(); }
}
async function start() {
  const child = fork(resolve(__dirname, 'helpers/admin-server.js'), [database, dataRoot], { silent: true });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    const url = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(output)), 20000);
      child.once('message', message => { clearTimeout(timer); done(message.url); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Admin server exited ' + code + ': ' + output)); });
    });
    return { url, child, stop: async () => {
      if (child.exitCode !== null) return;
      await new Promise(done => { child.once('exit', done); child.send('stop'); });
    } };
  } catch (error) { child.kill(); throw error; }
}
async function api(name, data = {}, user = 'admin') {
  const response = await fetch(server.url + '/benchmark-admin/' + name, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? auth(user) : {}) }, body: JSON.stringify(data) });
  const text = await response.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body: typeof body.value === 'string' ? JSON.parse(body.value) : body };
}
async function action(name, data = {}, user = 'admin') {
  const result = await api(name, data, user);
  assert.equal(result.status, 200, name + ': ' + JSON.stringify(result.body));
  return result.body;
}
const client = user => require('../bench/cloud/fixture.js').createCloudFixture({ baseUrl: server.url, headers: auth(user) });
test.before(async () => {
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(resolve(scratch, 'admin-test-'));
  database = resolve(directory, 'fixture.sqlite'); dataRoot = resolve(directory, 'data');
  await mkdir(dataRoot);
  for (const name of names) await writeFile(resolve(dataRoot, 'perf-' + name + '.csv'), 'ID,groupNo,value,text\n' + seed.map(row => [row.ID, row.groupNo, row.value, row.text].join(',')).join('\n') + '\n');
  const model = await cds.load([resolve(root, 'apps/provider/srv'), require.resolve('@sap/cds-mtxs/db/extensions.cds')]);
  require('@sap/cds-oyster/lib/services/extService').enhanceModel(model);
  const ddl = cds.compile.to.sql(model, { dialect: 'sqlite' });
  extensionID = randomUUID();
  for (const tenant of ['tenant-a', 'tenant-b']) sql(db => {
    for (const statement of ddl) db.exec(statement);
    for (const name of names) for (const row of seed) db.prepare('INSERT INTO perf_' + name + '(ID,groupNo,value,text) VALUES (?,?,?,?)').run(row.ID, row.groupNo, row.value, row.text);
    db.prepare('INSERT INTO cds_xt_Extensions(ID,tag,csn,activated,cdsOysterVersion,isBlockedCode,timestamp) VALUES (?,?,?,?,?,?,?)').run(extensionID, 'benchmark', JSON.stringify({ extensions: [{ annotate: 'BenchmarkService.oysterNoop', '@extension.code': [{ phase: 'on', event: 'oysterNoop', extId: extensionID }] }] }), 'database', require('@sap/cds-oyster/package.json').version, 0, new Date().toISOString());
  }, tenant);
  server = await start();
});
test.after(async () => { await server?.stop(); if (directory) await rm(directory, { recursive: true, force: true }); });

test('admin API rejects anonymous, wrong-role and missing-tenant callers', async () => {
  for (const [user, status] of [[null, 401], ['viewer', 403], ['noTenant', 403]])
    assert.equal((await api('inspectFixture', {}, user)).status, status);
});
test('fixture inspection returns ordered samples, summaries and full canonical CSV identities', async () => {
  const fixture = await action('inspectFixture');
  assert.equal(fixture.valid, true);
  for (const name of names) {
    const table = fixture.tables[name];
    assert.equal(table.count, 3); assert.equal(table.uniqueKeys, 3);
    assert.equal(table.minID, 11); assert.equal(table.maxID, 99);
    assert.equal(table.minValue, 2); assert.equal(table.maxValue, 8);
    assert.equal(table.minTextBytes, 1); assert.equal(table.maxTextBytes, 1);
    assert.deepEqual(table.ids, [11, 37, 99]); assert.deepEqual(table.sample, seed);
    assert.match(table.canonicalHash, /^[0-9a-f]{64}$/);
    assert.equal(table.canonicalHash, fixture.sources[name].canonicalHash);
    assert.equal(fixture.sources[name].csvSha256, digest(await readFile(resolve(dataRoot, 'perf-' + name + '.csv'))));
  }
  assert.equal(fixture.tables.WriteRows.canonicalHash, digest(seed.map(row => JSON.stringify([row.ID, row.groupNo, row.value, row.text, null, null, 1, 1]) + '\n').join('')));
});
test('cloud runner measures through tenant HTTP controls and commits exportable final evidence', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  const { exportRun } = require('../bench/cloud/export.js');
  const reportDir = resolve(directory, 'campaign');
  const identity = { headers: auth(), ensureWindow: async () => auth(), assertProvider: () => true };
  const result = await runCloudBenchmark({ suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1,
    filter: '^action/SmallRows/native-empty/direct', settlingMs: 1 }, { baseUrl: server.url, auth: identity, reportDir, environment: { foundation: 'test-foundation', region: 'local-test' } });
  assert.equal(result.manifest.runSummary.passed, true, JSON.stringify(result.manifest));
  assert.equal(result.results.length, 1); assert.ok(result.results[0].generatorResources.rssPeakMiB > 0);
  assert.equal(result.manifest.environment.runner.dependencies.autocannon, require('autocannon/package.json').version);
  assert.equal((await client().state()).lease.active, false);
  const restored = resolve(directory, 'campaign-export'); await mkdir(restored);
  const evidence = require('../bench/cloud/evidence.js').createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const exported = await exportRun({ client: evidence, runID: result.runID, outputRoot: restored });
  assert.ok(exported.paths.length > 3);
  assert.equal(await readFile(resolve(restored, 'report.md'), 'utf8'), await readFile(resolve(reportDir, 'report.md'), 'utf8'));
  assert.equal(JSON.stringify(result).includes(auth().authorization), false);
});
test('batched measurements replace report checkpoints and successful-case files', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  const reportDir = resolve(directory, 'batched-evidence');
  const identity = { headers: auth(), ensureWindow: async () => auth(), assertProvider: () => true };
  const result = await runCloudBenchmark({ suite: 'short', repetitions: 21, seed: 42, warmup: 0, duration: 1,
    filter: '^action/SmallRows/native-empty/direct', settlingMs: 1 }, { baseUrl: server.url, auth: identity, reportDir });
  assert.equal(result.manifest.runSummary.passed, true, JSON.stringify(result.manifest));
  const evidence = require('../bench/cloud/evidence.js').createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const artifacts = await evidence.listArtifacts(result.runID);
  const batches = artifacts.filter(artifact => artifact.path.startsWith('measurements/'));
  assert.equal(batches.length, 2, '21 measurements persist a batch of 20 and one final tail');
  assert.equal(artifacts.some(a => /^(checkpoints|sources|raw)\//.test(a.path)), false);
  assert.deepEqual(await readdir(resolve(reportDir, 'raw')), []);
  const restored = resolve(directory, 'batched-export'); await mkdir(restored);
  const restoredRecords = [];
  for (const artifact of batches.sort((a,b) => a.path.localeCompare(b.path))) {
    const file = await evidence.downloadArtifact({ artifactID: artifact.ID, root: restored });
    const batch = JSON.parse(await readFile(file));
    restoredRecords.push(...batch.records);
  }
  assert.equal(restoredRecords.length, 21);
  assert.deepEqual(restoredRecords.map(r => r.stats), result.results.map(r => r.stats));
  assert.ok((await readFile(resolve(reportDir, 'final-report.json'))).length < 2048);
  assert.ok((await readFile(resolve(reportDir, 'details.md'))).length);
});
test('failed batch uploads retain buffered observations and finish with recoverable final results', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  const reportDir = resolve(directory, 'batch-upload-failure');
  const evidence = require('../bench/cloud/evidence.js').createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const uploadArtifact = evidence.uploadArtifact;
  evidence.uploadArtifact = async options => {
    if (options.path.startsWith('measurements/')) throw new Error('Batch upload interrupted');
    return uploadArtifact(options);
  };
  const identity = { headers: auth(), ensureWindow: async () => auth(), assertProvider: () => true };
  const result = await runCloudBenchmark({ suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1, pilot: true,
    filter: '^action/SmallRows/native-empty/direct', settlingMs: 1 }, { baseUrl: server.url, auth: identity, reportDir, evidence });
  assert.equal(result.manifest.runSummary.passed, false);
  assert.match(result.manifest.error, /Batch upload interrupted/);
  assert.equal(JSON.parse(await readFile(resolve(reportDir, 'results.json'))).length, 1);
  assert.ok((await readdir(resolve(reportDir, 'measurements'))).length);
  assert.equal((await evidence.getRun(result.runID)).status, 'failed');
  assert.equal((await client().state()).lease.active, false);
});
test('bounded cloud pilot forces renewal and verifies tenant artifact readback outside timing', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  let forced = 0;
  const identity = { headers: auth(), ensureWindow: async (window, options) => { if (options?.force) forced++; return auth(); }, assertProvider: () => true };
  const result = await runCloudBenchmark({ suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1, pilot: true,
    filter: '^action/SmallRows/native-empty/direct', settlingMs: 1 }, { baseUrl: server.url, auth: identity, reportDir: resolve(directory, 'bounded-pilot') });
  assert.equal(result.manifest.runSummary.passed, true, JSON.stringify(result.manifest));
  assert.equal(forced, 1); assert.equal(result.results[0].stats.offeredRps, 3); assert.ok(result.results[0].stats.successes <= 6);
  assert.equal(result.manifest.validation.pilotEvidenceReadbackVerified, true);
});
test('cloud interruption after a completed case persists partial artifacts and releases its lease', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  const controller = new AbortController(), controls = client();
  let states = 0;
  const adapter = { ...controls, state: async () => { const state = await controls.state(); if (++states === 3) controller.abort(new Error('test interruption')); return state; } };
  const identity = { headers: auth(), ensureWindow: async () => auth(), assertProvider: () => true };
  const result = await runCloudBenchmark({ suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1,
    filter: '^action/SmallRows/(native-empty|native-compute)/direct/service/rows10/cpu100/calls1/batch$', settlingMs: 1 },
  { baseUrl: server.url, auth: identity, reportDir: resolve(directory, 'interrupted-campaign'), signal: controller.signal, adapter });
  assert.equal(result.manifest.runSummary.passed, false); assert.equal(result.results.length, 1);
  const evidence = require('../bench/cloud/evidence.js').createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const saved = await evidence.getRun(result.runID);
  assert.equal(saved.status, 'interrupted'); assert.ok(saved.finalArtifact_ID);
  assert.ok((await evidence.listArtifacts(result.runID)).some(artifact => artifact.path.startsWith('measurements/') && artifact.status === 'complete'));
  assert.equal((await controls.state()).lease.active, false);
});
test('cloud whole scan uses tenant HTTP reference chunks and independent generator/provider samples', async () => {
  const { cloudScanChunks, executeCloudScan } = require('../bench/cloud/run.js');
  const controls = client(), fixture = await controls.inspectFixture();
  const chunks = await cloudScanChunks(controls, fixture);
  assert.equal(chunks.length, 1); assert.equal(chunks[0].count, 3); assert.equal(chunks[0].lastID, 99);
  const run = { scenario: { ...scenario({ mode: 'native-compute', operation: 'scan', scanRows: 50000 }), scanCoordination: 'external', wholeScanRows: 3 }, repetition: 1, transport: 'http', load: { kind: 'vus', value: 1 } };
  const state = await controls.state(); await controls.acquireLease({ owner: 'whole-scan-test' });
  try {
    const records = await executeCloudScan(run, { server: { url: server.url, state, headers: auth() }, adapter: controls, chunks,
      rawDir: directory, prefix: 'whole-scan-cloud', signal: new AbortController().signal, auth: {} });
    assert.equal(records[0].validation.passed, true, JSON.stringify(records[0]));
    assert.equal(records[0].stats.successes, 1); assert.ok(records[0].wholeScanElapsedSeconds > 0);
    assert.ok(records[0].generatorResources.rssPeakMiB > 0); assert.ok(records[0].resources.rssPeakMiB > 0);
  } finally { await controls.releaseLease(); }
});
test('failed diagnostic upload resolves its recovery path before immutable measurement persistence', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  const adapter = client(), state = adapter.state;
  let states = 0;
  adapter.state = async () => { const value = await state(); if (++states === 3) value.extensionHealthy = false; return value; };
  const originalFetch = global.fetch;
  let uploadingRaw = false, failed = false;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/beginArtifact') && JSON.parse(options.body).path.startsWith('raw/')) uploadingRaw = true;
    const response = await originalFetch(url, options);
    if (uploadingRaw && !failed && String(url).endsWith('/putPart')) { failed = true; throw new Error('Diagnostic upload interrupted'); }
    return response;
  };
  let result;
  try {
    const identity = { headers: auth(), ensureWindow: async () => auth(), assertProvider: () => true };
    result = await runCloudBenchmark({ suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1,
      filter: '^action/SmallRows/native-empty/direct', settlingMs: 1 }, { baseUrl: server.url, auth: identity, adapter,
      reportDir: resolve(directory, 'diagnostic-recovery') });
  } finally { global.fetch = originalFetch; }
  assert.equal(failed, true); assert.equal(result.manifest.runSummary.passed, false);
  const evidence = require('../bench/cloud/evidence.js').createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const artifacts = await evidence.listArtifacts(result.runID);
  assert.ok(artifacts.some(a => a.status === 'complete' && a.path.startsWith('partial/raw/')));
  const batch = artifacts.find(a => a.status === 'complete' && a.path.startsWith('measurements/'));
  const target = resolve(directory, 'diagnostic-recovery-export'); await mkdir(target);
  const records = JSON.parse(await readFile(await evidence.downloadArtifact({ artifactID: batch.ID, root: target }))).records;
  assert.equal(records[0].rawFile, result.results[0].rawFile);
  assert.match(records[0].rawFile, /partial\/raw\//);
});
test('cancellation during artifact upload retains pending evidence and commits recovered raw files', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  const controller = new AbortController(), originalFetch = global.fetch;
  let rawUpload = false, interrupted = false;
  global.fetch = async (url, options) => {
    if (String(url).endsWith('/beginArtifact') && JSON.parse(options.body).path.startsWith('measurements/')) rawUpload = true;
    const response = await originalFetch(url, options);
    if (rawUpload && !interrupted && String(url).endsWith('/putPart')) { interrupted = true; controller.abort(new Error('upload interruption')); }
    return response;
  };
  let result;
  try {
    const identity = { headers: auth(), ensureWindow: async () => auth(), assertProvider: () => true };
    result = await runCloudBenchmark({ suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1,
      filter: '^action/SmallRows/native-empty/direct', settlingMs: 1 }, { baseUrl: server.url, auth: identity,
      reportDir: resolve(directory, 'upload-interrupted-campaign'), signal: controller.signal });
  } finally { global.fetch = originalFetch; }
  assert.equal(interrupted, true); assert.equal(result.manifest.runSummary.passed, false);
  const evidence = require('../bench/cloud/evidence.js').createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  assert.equal((await evidence.getRun(result.runID)).status, 'interrupted');
  const artifacts = await evidence.listArtifacts(result.runID);
  assert.ok(artifacts.some(artifact => artifact.status === 'pending' && artifact.path.startsWith('measurements/')));
  const recovered = artifacts.find(artifact => artifact.status === 'complete' && artifact.path.startsWith('partial/measurements/'));
  assert.ok(recovered);
  const target = resolve(directory, 'recovered-upload'); await mkdir(target);
  assert.ok((await readFile(await evidence.downloadArtifact({ artifactID: recovered.ID, root: target }))).length);
  assert.equal((await client().state()).lease.active, false);
});
test('real SIGTERM during final uploads commits an interrupted archive and consistent exported manifest', async () => {
  const child = fork(resolve(__dirname, 'helpers/cloud-finalization-signal.js'), [server.url, resolve(directory, 'signal-finalization')], { silent: true });
  let runID, finished, output = '';
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  child.on('message', message => {
    if (message.type === 'run') runID = message.runID;
    if (message.type === 'final-upload') child.kill('SIGTERM');
    if (message.type === 'finished') finished = message;
  });
  const exit = await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Signal runner timeout: ' + output)); }, 30000);
    child.once('exit', (code, signal) => { clearTimeout(timer); done({ code, signal }); });
  });
  assert.equal(exit.code, 0, JSON.stringify({ exit, output })); assert.equal(finished.passed, false);
  const evidence = require('../bench/cloud/evidence.js').createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const run = await evidence.getRun(runID); assert.equal(run.status, 'interrupted'); assert.ok(run.finalArtifact_ID);
  const target = resolve(directory, 'signal-export'); await mkdir(target);
  await require('../bench/cloud/export.js').exportRun({ client: evidence, runID, outputRoot: target });
  const manifest = JSON.parse(await readFile(resolve(target, 'manifest.json')));
  assert.equal(manifest.runSummary.passed, false); assert.match(manifest.error, /interrupted/i);
  assert.equal((await client().state()).lease.active, false);
});
test('cloud reference applies page, sparse key, range, group and deep offset semantics', async () => {
  const fixture = await client().inspectFixture();
  for (const [queryShape, offset, expected] of [['page', 0, [11, 37]], ['key', 0, [11]], ['range', 0, [11, 37]], ['non-indexed', 0, [11, 99]], ['offset', 1, [37, 99]]]) {
    const s = scenario({ operation: 'read', rows: 2, queryShape, offset });
    assert.deepEqual((await client().readReference(s, fixture, requestFor(s, fixture))).map(row => row.ID), expected);
  }
});
test('admin reference rejects arbitrary targets, invalid shapes and unbounded queries', async () => {
  for (const specification of [{ table: 'benchmark.evidence.Runs', rows: 1 }, { table: 'SmallRows', shape: 'sql', rows: 1 },
    { table: 'SmallRows', shape: 'page', rows: 10001 }, { table: 'SmallRows', shape: 'offset', rows: 1, offset: -1 },
    { table: 'SmallRows', shape: 'key', rows: 1, ID: '11 OR 1=1' }])
    assert.equal((await api('readReference', { specification: JSON.stringify(specification) })).status, 400);
  assert.equal((await api('scanReference', { specification: JSON.stringify({ scanRows: 1000001, iterations: 100 }) })).status, 400);
});
test('server paged scan computes the independent signed-32-bit reference checksum', async () => {
  const expected = seed.reduce((sum, row) => { let value = row.value; for (let i = 0; i < 3; i++) value = (value * 17 + i * 2 - 1) & 2147483647; return (sum + value) & 2147483647; }, 0);
  assert.equal(await client().scanReference({ scanRows: 3, iterations: 3 }), expected);
  await assert.rejects(client().scanReference({ scanRows: 4, iterations: 0 }), /400/);
});
test('state reports actual tenant model, live extension block/version and provider resources', async () => {
  const state = await client().state();
  assert.equal(state.tenant, 'tenant-a'); assert.equal((await client('other').state()).tenant, 'tenant-b');
  assert.ok(state.instance.ID); assert.equal(state.engine, 'oyster');
  assert.ok(state.versions.cds); assert.ok(state.versions.oyster); assert.ok(state.memoryLimit);
  assert.ok(state.annotations.some(a => a.name === 'BenchmarkService.oysterNoop' && a.extId === extensionID));
  assert.equal(state.extensions[0].ID, extensionID); assert.equal(state.extensionHealthy, true);
  sql(db => db.prepare('UPDATE cds_xt_Extensions SET isBlockedCode=1,blockedCodeReason=? WHERE ID=?').run('probe block', extensionID));
  const blocked = await client().state();
  assert.equal(blocked.extensionHealthy, false); assert.equal(blocked.extensions[0].blockedCodeReason, 'probe block');
  sql(db => db.prepare('UPDATE cds_xt_Extensions SET isBlockedCode=0,cdsOysterVersion=? WHERE ID=?').run('0.0.0', extensionID));
  assert.equal((await client().state()).extensionHealthy, false);
  sql(db => db.prepare('UPDATE cds_xt_Extensions SET cdsOysterVersion=? WHERE ID=?').run(require('@sap/cds-oyster/package.json').version, extensionID));
});
test('routine state stays compact while restoration status retains full snapshots', async () => {
  const one = client(), lease = await one.acquireLease({ owner: 'compact reset state' });
  try {
    const job = await one.reset({ pollMs: 5 });
    assert.equal(job.status, 'succeeded'); assert.equal(job.after.valid, true);
    const before = { retained: 'b'.repeat(512 * 1024) }, after = { retained: 'a'.repeat(512 * 1024) };
    sql(db => db.prepare('UPDATE benchmark_control_RestoreJobs SET before=?,after=? WHERE ID=?').run(JSON.stringify(before), JSON.stringify(after), job.ID));
    for (const status of ['running', 'succeeded', 'failed']) {
      const completedAt = status === 'running' ? null : job.completedAt, error = status === 'failed' ? 'retained reset diagnostic' : null;
      sql(db => {
        db.prepare('UPDATE benchmark_control_RestoreJobs SET status=?,completedAt=?,error=? WHERE ID=?').run(status, completedAt, error, job.ID);
        db.prepare('UPDATE benchmark_control_CampaignLease SET resetStatus=? WHERE ID=1').run(status);
      });
      const state = await one.state();
      assert.ok(Buffer.byteLength(JSON.stringify(state)) < 16 * 1024, 'Routine state must exclude oversized restoration snapshots');
      assert.deepEqual(state.reset, { ID: job.ID, status, instanceID: job.instanceID, startedAt: job.startedAt, completedAt, error });
      assert.equal(state.resetting, status === 'running');
    }
    const retained = await action('resetStatus', { leaseToken: lease.token, jobID: job.ID });
    assert.deepEqual(retained.before, before); assert.deepEqual(retained.after, after);
    assert.equal(retained.status, 'failed'); assert.equal(retained.error, 'retained reset diagnostic');
    assert.equal(Object.hasOwn(retained, 'token'), false);
  } finally {
    sql(db => db.prepare('UPDATE benchmark_control_CampaignLease SET resetStatus=? WHERE ID=1').run('failed'));
    await one.releaseLease();
  }
});
test('restoration drains requests started before acquisition and between released leases', async () => {
  const one = client();
  for (const owner of ['before first acquisition', 'after release and reacquisition']) {
    sql(db => db.exec('UPDATE perf_WriteRows SET value=777 WHERE ID=11'));
    const started = new Promise(done => server.child.once('message', done));
    const pending = fetch(server.url + '/benchmark/probe', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json', 'x-test-delay': 'hold' }, body: '{}' });
    await started;
    const lease = await one.acquireLease({ owner });
    let job = await action('reset', { leaseToken: lease.token });
    try {
      await new Promise(done => setTimeout(done, 100));
      job = await action('resetStatus', { leaseToken: lease.token, jobID: job.ID });
      assert.equal(job.status, 'running', owner);
      assert.equal(sql(db => db.prepare('SELECT value FROM perf_WriteRows WHERE ID=11').get()).value, 777);
    } finally {
      server.child.send('release-held-probe');
      const response = await pending; await response.arrayBuffer();
      do { await new Promise(done => setTimeout(done, 5)); job = await action('resetStatus', { leaseToken: lease.token, jobID: job.ID }); } while (job.status === 'running');
      await one.releaseLease();
    }
    assert.equal(job.status, 'succeeded');
  }
});
test('persisted tenant leases reject overlap, renew, release and expire atomically', async () => {
  const one = client(), two = client('second');
  const lease = await one.acquireLease({ owner: 'one', ttlMs: 1000 });
  await assert.rejects(two.acquireLease({ owner: 'two' }), /409/);
  assert.equal((await one.renewLease({ ttlMs: 2000 })).token, lease.token);
  const other = client('other'); await other.acquireLease({ owner: 'other tenant' }); await other.releaseLease();
  await one.releaseLease(); await two.acquireLease({ owner: 'two', ttlMs: 1000 });
  sql(db => db.exec("UPDATE benchmark_control_CampaignLease SET expiresAt='2000-01-01T00:00:00Z'"));
  await one.acquireLease({ owner: 'new' });
  await assert.rejects(two.renewLease(), /409/);
  await one.releaseLease();
});
test('resource sampling requires lease ownership and produces process metrics', async () => {
  const one = client(), two = client('second');
  await assert.rejects(one.metricsStart(), /409/);
  await one.acquireLease({ owner: 'metrics' });
  await one.metricsStart();
  await assert.rejects(two.metricsStop(), /409/);
  await assert.rejects(one.reset(), /409/);
  await new Promise(done => setTimeout(done, 130));
  const metrics = await one.metricsStop();
  assert.ok(metrics.elapsedSeconds > 0); assert.ok(metrics.rssPeakBytes > 0); assert.ok(metrics.cpuUserMs >= 0);
  assert.ok(metrics.instance.ID); await one.releaseLease();
});
test('two transactional restores reverse fixture mutations and preserve committed evidence bytes and active extension', async () => {
  const { createEvidenceClient } = require('../bench/cloud/evidence.js');
  const evidence = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const original = Buffer.from('committed evidence survives resets\n');
  await writeFile(resolve(directory, 'artifact.bin'), original);
  const run = await evidence.beginRun({ suite: 'fixture-test' });
  const artifact = await evidence.uploadArtifact({ runID: run.ID, path: 'artifact.bin', root: directory });
  await evidence.finishRun({ runID: run.ID, status: 'passed', finalArtifactID: artifact.ID });
  const before = await evidence.getArtifact(artifact.ID), one = client();
  await one.acquireLease({ owner: 'reset' });
  const baseline = await one.writeStateHash();
  for (let i = 0; i < 2; i++) {
    sql(db => db.exec('UPDATE perf_WriteRows SET value=123,quantity=44; INSERT INTO perf_WriteRows(ID,value) VALUES(999,99); UPDATE perf_SideEffectRows SET value=321; DELETE FROM perf_LookupRows WHERE ID=37'));
    assert.notEqual(await one.writeStateHash(), baseline);
    const reset = await one.reset({ pollMs: 5 });
    assert.equal(reset.status, 'succeeded'); assert.equal(reset.after.valid, true); assert.equal(reset.before.valid, false);
    assert.equal(await one.writeStateHash(), baseline); assert.equal((await one.state()).extensionHealthy, true);
    assert.deepEqual(await evidence.getArtifact(artifact.ID), before);
    const destination = resolve(directory, 'download-' + i); await mkdir(destination);
    assert.deepEqual(await readFile(await evidence.downloadArtifact({ artifactID: artifact.ID, root: destination })), original);
  }
  await one.releaseLease();
});
test('reset reports failure and rolls back all tables if retained CSV input is missing', async () => {
  const one = client(); await one.acquireLease({ owner: 'failure' });
  const path = resolve(dataRoot, 'perf-SideEffectRows.csv'), bytes = await readFile(path);
  await rm(path);
  try {
    await assert.rejects(one.reset({ pollMs: 5 }), /reset.*failed/i);
    assert.equal((await one.state()).reset.status, 'failed');
  } finally { await writeFile(path, bytes); await one.releaseLease(); }
});
test('a running restoration drains requests, rejects business traffic and survives lease expiration', async () => {
  const one = client(), two = client('second');
  const lease = await one.acquireLease({ owner: 'quiesce', ttlMs: 1000 });
  const pending = fetch(server.url + '/benchmark/probe', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json', 'x-test-delay': '1' }, body: '{}' });
  await new Promise(done => setTimeout(done, 50));
  let job = await action('reset', { leaseToken: lease.token });
  assert.equal(job.status, 'running');
  sql(db => db.exec("UPDATE benchmark_control_CampaignLease SET expiresAt='2000-01-01T00:00:00Z'"));
  await assert.rejects(two.acquireLease({ owner: 'overlap' }), /409/);
  assert.equal((await fetch(server.url + '/benchmark/probe', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{}' })).status, 503);
  assert.equal((await fetch(server.url + '/benchmark-extension/nativeEmpty', { method: 'POST', headers: { ...auth(), 'content-type': 'application/json' }, body: '{"seed":7}' })).status, 503);
  await one.renewLease();
  assert.equal((await pending).status, 200);
  do { await new Promise(done => setTimeout(done, 5)); job = await action('resetStatus', { leaseToken: lease.token, jobID: job.ID }); } while (job.status === 'running');
  assert.equal(job.status, 'succeeded'); await one.releaseLease();
});
test('a mid-restoration insertion failure rolls back every fixture table and preserves evidence', async () => {
  const one = client(); await one.acquireLease({ owner: 'transaction failure' });
  sql(db => db.exec('UPDATE perf_WriteRows SET value=999; UPDATE perf_SideEffectRows SET value=888; CREATE TRIGGER reset_failure BEFORE INSERT ON perf_LookupRows BEGIN SELECT RAISE(ABORT,\'reset insert failure\'); END'));
  const rows = () => sql(db => names.map(name => db.prepare('SELECT * FROM perf_' + name + ' ORDER BY ID').all()));
  const before = rows();
  const evidence = () => sql(db => ['Runs', 'Artifacts', 'ArtifactParts'].map(name => db.prepare('SELECT * FROM benchmark_evidence_' + name + ' ORDER BY ID').all()));
  const saved = evidence();
  try {
    await assert.rejects(one.reset({ pollMs: 5 }), /reset.*failed/i);
    assert.deepEqual(rows(), before); assert.deepEqual(evidence(), saved);
    assert.equal((await one.state()).reset.status, 'failed');
  } finally { sql(db => db.exec('DROP TRIGGER reset_failure')); await one.reset({ pollMs: 5 }); await one.releaseLease(); }
});
test('cloud fixture accepts asynchronous cached-header providers outside measured requests', async () => {
  let calls = 0;
  const fixture = require('../bench/cloud/fixture.js').createCloudFixture({ baseUrl: server.url,
    headers: async () => { calls++; return auth(); } });
  assert.equal((await fixture.state()).tenant, 'tenant-a'); assert.equal(calls, 1);
});
test('streamed fixture validation covers rows beyond the sample and parses quoted multiline CDS CSV', async () => {
  const one = client(); await one.acquireLease({ owner: 'paged fixture' });
  const path = resolve(dataRoot, 'perf-SmallRows.csv'), original = await readFile(path);
  const records = Array.from({ length: 12007 }, (_, i) => ({ ID: i + 1, groupNo: i % 2, value: i % 100,
    text: i === 12006 ? 'quoted,line\ncontinued' : 'row' }));
  const csv = 'ID,groupNo,value,text\n' + records.map(row => [row.ID, row.groupNo, row.value, '"' + row.text + '"'].join(',')).join('\n') + '\n';
  await writeFile(path, csv);
  try {
    await one.reset({ pollMs: 5 });
    const fixture = await one.inspectFixture(), summary = fixture.tables.SmallRows;
    assert.equal(fixture.valid, true); assert.equal(summary.count, 12007); assert.equal(summary.sample.length, 1000);
    assert.equal(summary.canonicalHash, digest(records.map(row => JSON.stringify([row.ID, row.groupNo, row.value, row.text]) + '\n').join('')));
    sql(db => db.exec('UPDATE perf_SmallRows SET value=9999 WHERE ID=12007'));
    const changed = await one.inspectFixture();
    assert.equal(changed.valid, false); assert.deepEqual(changed.tables.SmallRows.sample, summary.sample);
  } finally { await writeFile(path, original); await one.reset({ pollMs: 5 }); await one.releaseLease(); }
});
test('concurrent first acquisition permits exactly one persisted tenant lease owner', async () => {
  sql(db => db.exec('DELETE FROM benchmark_control_CampaignLease'), 'tenant-b');
  const contenders = [client('other'), client('other')];
  const results = await Promise.allSettled(contenders.map((fixture, i) => fixture.acquireLease({ owner: 'concurrent-' + i })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await contenders[results.findIndex(result => result.status === 'fulfilled')].releaseLease();
});
