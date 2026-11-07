const test = require('node:test');
const assert = require('node:assert/strict');
const { fork, execFileSync } = require('node:child_process');
const { mkdir, mkdtemp, rm, writeFile, readFile, readdir, symlink } = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { homedir } = require('node:os');
const { randomBytes, createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');

const root = resolve(__dirname, '..');
const scratch = resolve(homedir(), 'git/clean-room/oyster-btp-implementation-20261106');
const cdsCLI = resolve(root, 'node_modules/@sap/cds-dk/bin/cds.js');
const PART_BYTES = 48 * 1024;
let directory, server, database;

async function start(database) {
  const child = fork(resolve(__dirname, 'helpers/evidence-server.js'), [database], { silent: true });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  try {
    const url = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error('Evidence server startup timeout: ' + output)), 15000);
      child.once('message', message => { clearTimeout(timer); done(message.url); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Evidence server exited ' + code + ': ' + output)); });
    });
    return { url, stop: async () => {
      if (child.exitCode !== null) return;
      await new Promise(done => { child.once('exit', done); child.send('stop'); });
    } };
  } catch (error) { child.kill(); throw error; }
}

function auth(user = 'recorder') { return { authorization: 'Basic ' + Buffer.from(user + ':').toString('base64') }; }

async function request(path, { method = 'POST', body, user = 'recorder' } = {}) {
  const response = await fetch(server.url + '/benchmark-evidence/' + path, {
    method, headers: { 'content-type': 'application/json', ...(user ? auth(user) : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value; try { value = JSON.parse(text); } catch { value = text; }
  return { status: response.status, body: value };
}

test.before(async () => {
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(resolve(scratch, 'evidence-test-'));
  database = resolve(directory, 'evidence.sqlite');
  const model = resolve(root, 'apps/provider/srv/evidence-service.cds');
  if (existsSync(model)) for (const tenant of ['tenant-a', 'tenant-b'])
    execFileSync(process.execPath, [cdsCLI, 'deploy', model, '--to', 'sqlite:' + database.replace('.sqlite', '-' + tenant + '.sqlite')], { cwd: root });
  server = await start(database);
});

test.after(async () => {
  await server?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test('recorder API starts a tenant-backed run over CAP HTTP', async () => {
  const result = await request('beginRun', { body: { manifest: JSON.stringify({ suite: 'short', repetition: 1 }) } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.match(result.body.ID, /^[0-9a-f-]{36}$/);
  assert.equal(result.body.status, 'open');
  assert.equal(result.body.createdBy, 'recorder');
});

async function action(name, body) {
  const result = await request(name, { body });
  assert.equal(result.status, 200, name + ': ' + JSON.stringify(result.body));
  return result.body;
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const begin = () => action('beginRun', { manifest: JSON.stringify({ suite: 'short' }) });

function metadata(runID, path, original, compressed = gzipSync(original)) {
  return { runID, path, originalBytes: original.length, compressedBytes: compressed.length,
    originalSha256: digest(original), compressedSha256: digest(compressed), partCount: Math.ceil(compressed.length / PART_BYTES) };
}

async function uploadParts(artifactID, compressed, ordinals = Array.from({ length: Math.ceil(compressed.length / PART_BYTES) }, (_, i) => i)) {
  for (const ordinal of ordinals) {
    const result = await request('putPart', { body: { artifactID, ordinal, content: compressed.subarray(ordinal * PART_BYTES, (ordinal + 1) * PART_BYTES).toString('base64') } });
    assert.equal(result.status, 204, JSON.stringify(result.body));
  }
}

async function store(runID, path, original) {
  const compressed = gzipSync(original);
  const artifact = await action('beginArtifact', metadata(runID, path, original, compressed));
  await uploadParts(artifact.ID, compressed);
  return action('completeArtifact', { artifactID: artifact.ID });
}

test('CAP denies anonymous, wrong-role and absent-tenant evidence requests', async () => {
  for (const [user, status] of [[null, 401], ['viewer', 403], ['noTenant', 403]]) {
    for (const path of ['Runs', 'Artifacts']) assert.equal((await request(path, { method: 'GET', user })).status, status);
    assert.equal((await request('beginRun', { body: { manifest: '{}' }, user })).status, status);
  }
});

test('run manifests must be bounded JSON objects', async () => {
  for (const manifest of ['invalid', 'null', '[]', JSON.stringify({ huge: 'x'.repeat(33000) })])
    assert.equal((await request('beginRun', { body: { manifest } })).status, 400, manifest.slice(0, 20));
});

test('multipart binary artifacts validate, retrieve ordered parts and become immutable', async () => {
  const run = await begin(), original = randomBytes(PART_BYTES * 3 + 517), compressed = gzipSync(original);
  const artifact = await action('beginArtifact', metadata(run.ID, 'raw/binary.bin', original, compressed));
  assert.equal(artifact.partCount, 4);
  assert.equal(artifact.compression, 'gzip');
  assert.equal((await request('getPart', { body: { artifactID: artifact.ID, ordinal: 0 } })).status, 409);
  await uploadParts(artifact.ID, compressed, [3, 1, 0, 2]);
  const completed = await action('completeArtifact', { artifactID: artifact.ID });
  assert.equal(completed.status, 'complete');
  assert.ok(completed.completedAt);
  const downloaded = [];
  for (let ordinal = 0; ordinal < 4; ordinal++) {
    const part = await action('getPart', { artifactID: artifact.ID, ordinal });
    assert.equal(typeof part.value, 'string', 'LargeBinary action responses use OData base64 strings');
    downloaded.push(Buffer.from(part.value, 'base64'));
  }
  assert.deepEqual(Buffer.concat(downloaded), compressed);
  assert.equal((await request('putPart', { body: { artifactID: artifact.ID, ordinal: 0, content: compressed.subarray(0, PART_BYTES).toString('base64') } })).status, 409);
  assert.equal((await request('completeArtifact', { body: { artifactID: artifact.ID } })).status, 409);
  for (const [path, method, body] of [['Runs', 'POST', {}], ['Runs(' + run.ID + ')', 'PATCH', { status: 'passed' }],
    ['Artifacts', 'POST', {}], ['Artifacts(' + artifact.ID + ')', 'PATCH', { path: 'changed' }], ['Artifacts(' + artifact.ID + ')', 'DELETE']])
    assert.equal((await request(path, { method, body })).status, 405);
  assert.equal((await request('ArtifactParts', { method: 'GET' })).status, 404);
});

test('metadata rejects unsafe paths, invalid hashes and out-of-bound byte and part counts', async () => {
  const run = await begin(), valid = metadata(run.ID, 'safe/report.md', Buffer.from('report'));
  for (const path of ['../report.md', '/tmp/report.md', 'a/../../b', 'a//b', 'a/./b', 'a' + String.fromCharCode(92) + 'b', 'C:/b', 'a/..', '.', 'a/' + String.fromCharCode(0) + 'b'])
    assert.equal((await request('beginArtifact', { body: { ...valid, path } })).status, 400, path);
  for (const changes of [{ originalBytes: -1 }, { originalBytes: 1073741825 }, { compressedBytes: 0 },
    { compressedBytes: 1073741825 }, { partCount: 0 }, { partCount: 2 }, { originalSha256: 'invalid' }, { compressedSha256: 'x'.repeat(64) }])
    assert.equal((await request('beginArtifact', { body: { ...valid, ...changes } })).status, 400, JSON.stringify(changes));
});

test('part writes reject missing, duplicate, short, oversized and out-of-range ordinals', async () => {
  const run = await begin(), original = randomBytes(PART_BYTES + 20), compressed = gzipSync(original);
  const artifact = await action('beginArtifact', metadata(run.ID, 'parts.bin', original, compressed));
  assert.equal((await request('completeArtifact', { body: { artifactID: artifact.ID } })).status, 409);
  for (const body of [{ ordinal: -1, content: 'AA==' }, { ordinal: 2, content: 'AA==' }, { ordinal: 0, content: 'AA==' },
    { ordinal: 0, content: randomBytes(PART_BYTES + 1).toString('base64') }])
    assert.equal((await request('putPart', { body: { artifactID: artifact.ID, ...body } })).status, 400);
  await uploadParts(artifact.ID, compressed, [0]);
  assert.equal((await request('putPart', { body: { artifactID: artifact.ID, ordinal: 0, content: compressed.subarray(0, PART_BYTES).toString('base64') } })).status, 409);
  assert.equal((await request('completeArtifact', { body: { artifactID: artifact.ID } })).status, 409);
  await uploadParts(artifact.ID, compressed, [1]);
  assert.equal((await action('completeArtifact', { artifactID: artifact.ID })).status, 'complete');
});

test('artifact completion rejects corrupted gzip, incorrect hashes and decompression beyond the declared bound', async () => {
  const run = await begin(), original = Buffer.from('large'.repeat(20000)), gzip = gzipSync(original);
  for (const [index, compressed, changes] of [[0, gzip, { originalSha256: '0'.repeat(64) }],
    [1, gzip, { compressedSha256: '0'.repeat(64) }], [2, gzip, { originalBytes: 5 }],
    [3, gzip, { originalBytes: original.length + 1 }], [4, randomBytes(30), {}], [5, gzip.subarray(0, gzip.length - 3), {}]]) {
    const artifact = await action('beginArtifact', { ...metadata(run.ID, 'bad-' + index + '.bin', original, compressed), ...changes });
    await uploadParts(artifact.ID, compressed);
    const completed = await request('completeArtifact', { body: { artifactID: artifact.ID } });
    assert.equal(completed.status, 422, JSON.stringify(completed.body));
    const persisted = await request('Artifacts(' + artifact.ID + ')', { method: 'GET' });
    assert.equal(persisted.body.status, 'pending');
    assert.equal(persisted.body.completedAt, null);
  }
});

test('passing a run requires a complete final report in the same run and no pending artifacts', async () => {
  const run = await begin(), other = await begin();
  const report = await store(run.ID, 'report.md', Buffer.from('# Report\nVerified evidence.\n'));
  const foreign = await store(other.ID, 'report.md', Buffer.from('Other run'));
  assert.equal((await request('finishRun', { body: { runID: run.ID, status: 'passed', finalArtifactID: foreign.ID } })).status, 409);
  assert.equal((await request('finishRun', { body: { runID: run.ID, status: 'invalid', finalArtifactID: report.ID } })).status, 400);
  const raw = Buffer.from('pending'), compressed = gzipSync(raw);
  const pending = await action('beginArtifact', metadata(run.ID, 'raw.json', raw, compressed));
  assert.equal((await request('finishRun', { body: { runID: run.ID, status: 'passed', finalArtifactID: report.ID } })).status, 409);
  assert.equal((await request('finishRun', { body: { runID: run.ID, status: 'passed', finalArtifactID: pending.ID } })).status, 409);
  await uploadParts(pending.ID, compressed);
  await action('completeArtifact', { artifactID: pending.ID });
  const finished = await action('finishRun', { runID: run.ID, status: 'passed', finalArtifactID: report.ID });
  assert.equal(finished.status, 'passed');
  assert.equal(finished.finalArtifact_ID, report.ID);
  assert.ok(finished.finishedAt);
  assert.equal((await request('beginArtifact', { body: metadata(run.ID, 'late.md', raw) })).status, 409);
  assert.equal((await request('finishRun', { body: { runID: run.ID, status: 'failed', finalArtifactID: report.ID } })).status, 409);
});

function storedParts(artifactID) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(database.replace('.sqlite', '-tenant-a.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT ID, ordinal, bytes, content FROM benchmark_evidence_ArtifactParts WHERE artifact_ID = ? ORDER BY ordinal').all(artifactID)
      .map(({ content, ...part }) => ({ ...part, storageSha256: digest(Buffer.from(content)) }));
  } finally { db.close(); }
}

for (const status of ['failed', 'interrupted']) test(status + ' runs finalize with pending uploads and preserve their evidence across restart', async () => {
  const { createEvidenceClient } = require('../bench/cloud/evidence.js');
  const run = await begin(), original = randomBytes(PART_BYTES + 100), compressed = gzipSync(original);
  const pending = await action('beginArtifact', metadata(run.ID, 'partial.bin', original, compressed));
  await uploadParts(pending.ID, compressed, [0]);
  const reportBytes = Buffer.from('# Partial report\nRun ' + status + ' during artifact upload.\n');
  const report = await store(run.ID, 'partial-report.md', reportBytes);
  const pendingBefore = (await request('Artifacts(' + pending.ID + ')', { method: 'GET' })).body;
  const partBefore = storedParts(pending.ID);
  assert.equal(partBefore.length, 1);
  assert.equal(partBefore[0].bytes, PART_BYTES);
  assert.equal((await request('finishRun', { body: { runID: run.ID, status: 'passed', finalArtifactID: report.ID } })).status, 409);
  assert.equal((await request('finishRun', { body: { runID: run.ID, status, finalArtifactID: pending.ID } })).status, 409);
  const finished = await action('finishRun', { runID: run.ID, status, finalArtifactID: report.ID });
  assert.equal(finished.status, status);
  assert.equal(finished.finalArtifact_ID, report.ID);
  assert.ok(finished.finishedAt);
  assert.deepEqual((await request('Artifacts(' + pending.ID + ')', { method: 'GET' })).body, pendingBefore);
  assert.deepEqual(storedParts(pending.ID), partBefore);
  assert.equal((await request('getPart', { body: { artifactID: pending.ID, ordinal: 0 } })).status, 409);
  assert.equal((await request('putPart', { body: { artifactID: pending.ID, ordinal: 1, content: compressed.subarray(PART_BYTES).toString('base64') } })).status, 409);
  for (const artifactID of [pending.ID, report.ID])
    assert.equal((await request('completeArtifact', { body: { artifactID } })).status, 409);
  assert.equal((await request('beginArtifact', { body: metadata(run.ID, 'late.md', reportBytes) })).status, 409);
  assert.equal((await request('finishRun', { body: { runID: run.ID, status: 'passed', finalArtifactID: report.ID } })).status, 409);
  await server.stop(); server = await start(database);
  const client = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  assert.equal((await client.getRun(run.ID)).status, status);
  assert.equal((await client.getArtifact(pending.ID)).status, 'pending');
  assert.deepEqual(storedParts(pending.ID), partBefore);
  const destination = resolve(directory, status + '-partial-download');
  await mkdir(destination);
  await assert.rejects(client.downloadArtifact({ artifactID: pending.ID, root: destination }), /incomplete/);
  assert.deepEqual(await readdir(destination), []);
  assert.deepEqual(await readFile(await client.downloadArtifact({ artifactID: report.ID, root: destination })), reportBytes);
  assert.equal((await request('putPart', { body: { artifactID: pending.ID, ordinal: 1, content: compressed.subarray(PART_BYTES).toString('base64') } })).status, 409);
});

test('duplicate logical paths conflict and tenant recorders cannot access other tenant evidence', async () => {
  const run = await begin(), original = Buffer.from('private');
  const artifact = await store(run.ID, 'private.md', original);
  assert.equal((await request('beginArtifact', { body: metadata(run.ID, 'private.md', original) })).status, 409);
  assert.equal((await request('Runs(' + run.ID + ')', { method: 'GET', user: 'otherRecorder' })).status, 404);
  assert.equal((await request('getPart', { body: { artifactID: artifact.ID, ordinal: 0 }, user: 'otherRecorder' })).status, 404);
});

test('streaming client round trips multipart binary, text and empty files and cleans temporary files', async () => {
  const modulePath = resolve(root, 'bench/cloud/evidence.js');
  assert.equal(existsSync(modulePath), true, 'streaming evidence client must exist');
  const { createEvidenceClient } = require(modulePath);
  const clientScratch = resolve(directory, 'client-scratch'), source = resolve(directory, 'source'), destination = resolve(directory, 'download');
  await mkdir(clientScratch); await mkdir(source); await mkdir(destination);
  const client = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: clientScratch });
  const run = await client.beginRun({ suite: 'short' });
  for (const [path, contents] of [['raw.bin', randomBytes(2 * 1024 * 1024 + 719)], ['report.md', Buffer.from('# A report\nMeasured results\n')], ['empty.json', Buffer.alloc(0)]]) {
    await writeFile(resolve(source, path), contents);
    const artifact = await client.uploadArtifact({ runID: run.ID, path, root: source });
    assert.equal(artifact.status, 'complete');
    if (path === 'raw.bin') assert.ok(artifact.partCount > 40);
    const file = await client.downloadArtifact({ artifactID: artifact.ID, root: destination });
    assert.deepEqual(await readFile(file), contents);
    assert.deepEqual(await readdir(clientScratch), []);
    assert.equal((await readdir(destination)).some(name => name.startsWith('.evidence-')), false);
  }
});

test('client rejects unsafe source paths and symlink traversal before uploading', async () => {
  const modulePath = resolve(root, 'bench/cloud/evidence.js');
  assert.equal(existsSync(modulePath), true, 'streaming evidence client must exist');
  const { createEvidenceClient } = require(modulePath);
  const source = resolve(directory, 'unsafe-source'), clientScratch = resolve(directory, 'unsafe-scratch');
  await mkdir(source); await mkdir(clientScratch);
  await symlink(directory, resolve(source, 'escape'));
  await symlink(resolve(directory, 'evidence-tenant-a.sqlite'), resolve(source, 'link.bin'));
  const client = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: clientScratch });
  const run = await client.beginRun({ suite: 'short' });
  for (const path of ['../outside', '/tmp/a', 'a/../b', 'escape/evidence-tenant-a.sqlite', 'link.bin'])
    await assert.rejects(client.uploadArtifact({ runID: run.ID, path, root: source }), /path|symlink/i);
  assert.deepEqual(await readdir(clientScratch), []);
});

test('client cleans compressed scratch after a real authorization failure', async () => {
  const { createEvidenceClient } = require('../bench/cloud/evidence.js');
  const source = resolve(directory, 'failed-source'), clientScratch = resolve(directory, 'failed-scratch');
  await mkdir(source); await mkdir(clientScratch);
  await writeFile(resolve(source, 'report.md'), 'A report');
  const run = await begin();
  const denied = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth('viewer'), scratch: clientScratch });
  await assert.rejects(denied.uploadArtifact({ runID: run.ID, path: 'report.md', root: source }), error => error.status === 403);
  assert.deepEqual(await readdir(clientScratch), []);
});

test('client rejects a symlink destination and leaves files outside its root untouched', async () => {
  const { createEvidenceClient } = require('../bench/cloud/evidence.js');
  const run = await begin(), report = await store(run.ID, 'linked/report.md', Buffer.from('Private report'));
  const destination = resolve(directory, 'linked-destination'), outside = resolve(directory, 'outside');
  await mkdir(destination); await mkdir(outside);
  await writeFile(resolve(outside, 'report.md'), 'sentinel');
  await symlink(outside, resolve(destination, 'linked'));
  const client = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  await assert.rejects(client.downloadArtifact({ artifactID: report.ID, root: destination }), /symlink/i);
  assert.equal(await readFile(resolve(outside, 'report.md'), 'utf8'), 'sentinel');
  assert.deepEqual(await readdir(destination), ['linked']);
});

test('client rejects tampered download bytes and hashes, preserves an existing destination and cleans scratch', async () => {
  const { createEvidenceClient } = require('../bench/cloud/evidence.js');
  const run = await begin(), report = await store(run.ID, 'report.md', Buffer.from('Verified report content'));
  const destination = resolve(directory, 'tampered-download');
  await mkdir(destination); await writeFile(resolve(destination, 'report.md'), 'sentinel');
  const client = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  const realFetch = global.fetch;
  try {
    for (const tamper of ['gzip', 'compressedHash', 'originalHash', 'unsafePath']) {
      // Keep real CAP requests and authentication; emulate corruption only after the response crosses HTTP.
      global.fetch = async (url, options) => {
        const response = await realFetch(url, options);
        if (!response.ok) return response;
        const body = await response.json();
        if (String(url).endsWith('/getPart')) {
          const bytes = Buffer.from(body.value, 'base64');
          if (tamper === 'gzip') bytes[0] ^= 1;
          if (tamper === 'compressedHash') bytes[9] ^= 1;
          body.value = bytes.toString('base64');
        } else if (String(url).includes('/Artifacts(')) {
          if (tamper === 'originalHash') body.originalSha256 = '0'.repeat(64);
          if (tamper === 'unsafePath') body.path = '../report.md';
        }
        return new Response(JSON.stringify(body), { status: response.status, headers: { 'content-type': 'application/json' } });
      };
      await assert.rejects(client.downloadArtifact({ artifactID: report.ID, root: destination }));
      assert.equal(await readFile(resolve(destination, 'report.md'), 'utf8'), 'sentinel');
      assert.deepEqual(await readdir(destination), ['report.md']);
    }
  } finally { global.fetch = realFetch; }
});

test('service restart preserves completed reports and partially uploaded runs in tenant SQLite files', async () => {
  const run = await begin(), original = Buffer.from('# Durable report\n');
  const report = await store(run.ID, 'report.md', original);
  await action('finishRun', { runID: run.ID, status: 'failed', finalArtifactID: report.ID });
  const interrupted = await begin(), raw = randomBytes(PART_BYTES + 100), compressed = gzipSync(raw);
  const partial = await action('beginArtifact', metadata(interrupted.ID, 'partial.bin', raw, compressed));
  await uploadParts(partial.ID, compressed, [0]);
  await server.stop();
  server = await start(database);
  const persisted = await request('Runs(' + run.ID + ')', { method: 'GET' });
  assert.equal(persisted.body.status, 'failed');
  assert.equal(persisted.body.finalArtifact_ID, report.ID);
  const { createEvidenceClient } = require('../bench/cloud/evidence.js');
  const client = createEvidenceClient({ url: server.url + '/benchmark-evidence', headers: auth(), scratch: directory });
  assert.equal((await client.getRun(run.ID)).status, 'failed');
  assert.equal((await client.getArtifact(report.ID)).status, 'complete');
  const destination = resolve(directory, 'restart-download');
  await mkdir(destination);
  assert.deepEqual(await readFile(await client.downloadArtifact({ artifactID: report.ID, root: destination })), original);
  const part = await action('getPart', { artifactID: report.ID, ordinal: 0 });
  assert.deepEqual(Buffer.from(part.value, 'base64'), gzipSync(original));
  assert.equal((await request('Artifacts(' + partial.ID + ')', { method: 'GET' })).body.status, 'pending');
  await uploadParts(partial.ID, compressed, [1]);
  assert.equal((await action('completeArtifact', { artifactID: partial.ID })).status, 'complete');
  const interruptedReport = await store(interrupted.ID, 'report.md', Buffer.from('Interrupted run'));
  assert.equal((await client.finishRun({ runID: interrupted.ID, status: 'interrupted', finalArtifactID: interruptedReport.ID })).status, 'interrupted');
});
