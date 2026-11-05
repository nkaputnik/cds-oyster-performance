import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { scenario } from '../bench/scenarios.mjs';
import { requestFor } from '../bench/requests.mjs';
import { cpu } from '../lib/workload.mjs';
import http from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';

const table = { count: 1000, minID: 1, maxID: 1000, ids: [1, 2], sample: [{ ID: 1, groupNo: 4, value: 3, text: 'fixture' }, { ID: 2, groupNo: 8, value: 5, text: 'fixture2' }] };
const fixture = { tables: Object.fromEntries(['SmallRows', 'LargeRows', 'WriteRows', 'LookupRows', 'SideEffectRows'].map(name => [name, table])) };

test('correctness rejects a plausible successful action with the wrong checksum', async () => {
  const { validateResponse, validateActivation } = await import('../bench/verify.mjs');
  const s = scenario({ mode: 'wasm-compute-read', callbacks: 5 });
  const request = requestFor(s, fixture);
  const expected = (cpu(7, s.iterations) + 15) & 2147483647;
  assert.equal(validateResponse(s, fixture, request, { status: 200, body: { value: expected } }).passed, true);
  assert.throws(() => validateResponse(s, fixture, request, { status: 200, body: { value: expected + 1 } }), /checksum/);
  assert.throws(() => validateActivation(s, { plugins: ['@sap/cds-oyster'], engine: 'debug', annotations: [] }, []), /engine/);
  assert.throws(() => validateActivation(scenario(), { plugins: ['@sap/cds-oyster'], annotations: [] }, []), /baseline/);
});

test('READ validation verifies count, fixture identity, and each enriched checksum', async () => {
  const { validateResponse } = await import('../bench/verify.mjs');
  const s = scenario({ mode: 'native-compute-read', operation: 'read', rows: 2, callbacks: 5 });
  const rows = table.sample.map(row => ({ ...row, checksum: (cpu(row.value, s.iterations) + 15) & 2147483647 }));
  const request = requestFor(s, fixture);
  assert.equal(validateResponse(s, fixture, request, { status: 200, body: { value: rows } }).rows, 2);
  assert.throws(() => validateResponse(s, fixture, request, { status: 200, body: { value: rows.slice(0, 1) } }), /row count/);
  assert.throws(() => validateResponse(s, fixture, request, { status: 200, body: { value: rows.map(row => ({ ...row, checksum: 0 })) } }), /checksum/);
});

test('READ query correctness accepts key objects and checks range, filter and offset identities', async () => {
  const { validateResponse } = await import('../bench/verify.mjs');
  const sample = [{ ID: 11, groupNo: 7, value: 2, text: 'a' }, { ID: 37, groupNo: 3, value: 8, text: 'b' }, { ID: 99, groupNo: 7, value: 4, text: 'c' }];
  const frozen = { tables: { ...fixture.tables, SmallRows: { count: 3, ids: sample.map(row => row.ID), sample } } };
  const row = value => ({ ...value, checksum: null });
  const s = scenario({ operation: 'read', queryShape: 'key' });
  const keyRequest = requestFor(s, frozen, { vu: 2 });
  assert.equal(validateResponse(s, frozen, keyRequest, { status: 200, body: row(sample[1]) }).rows, 1);
  assert.throws(() => validateResponse(s, frozen, keyRequest, { status: 200, body: row(sample[0]) }), /identity/);
  for (const [queryShape, offset, vu, expected] of [['range', 0, 2, sample.slice(1)], ['non-indexed', 0, 1, [sample[0], sample[2]]], ['offset', 1, 1, sample.slice(1)]]) {
    const s = scenario({ operation: 'read', rows: 2, queryShape, offset });
    const request = requestFor(s, frozen, { vu });
    const response = { status: 200, body: { value: expected.map(row) } };
    assert.equal(validateResponse(s, frozen, request, response, { readRows: expected }).rows, 2, queryShape);
    assert.throws(() => validateResponse(s, frozen, request, { status: 200, body: { value: expected.slice(0, 1).map(row) } }, { readRows: expected }), /row count/);
  }
});

test('READ frozen reference applies sparse ranges, non-indexed groups and deep offsets outside the sandbox', async () => {
  const { readReference } = await import('../bench/verify.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(resolve(import.meta.dirname, '../.read-reference-test-'));
  const database = resolve(root, 'fixture.sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE perf_SmallRows (ID INTEGER PRIMARY KEY, groupNo INTEGER, value INTEGER, text TEXT); INSERT INTO perf_SmallRows VALUES (11,7,2,\'a\'),(37,3,8,\'b\'),(99,7,4,\'c\')');
  db.close();
  const frozen = { tables: { SmallRows: { count: 3, ids: [11, 37, 99], sample: [{ ID: 11, groupNo: 7 }] } } };
  try {
    for (const [queryShape, offset, expectedIDs] of [['page', 0, [11, 37]], ['key', 0, [11]], ['range', 0, [11, 37]], ['non-indexed', 0, [11, 99]], ['offset', 1, [37, 99]]]) {
      const s = scenario({ operation: 'read', rows: 2, queryShape, offset });
      assert.deepEqual((await readReference(s, frozen, requestFor(s, frozen), { database })).map(row => row.ID), expectedIDs);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('mixed preflight exercises every operation before permitting warm timing', async () => {
  const { verifyScenario } = await import('../bench/verify.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const root = await mkdtemp(resolve(import.meta.dirname, '../.mixed-reference-test-'));
  const referenceDatabase = resolve(root, 'fixture.sqlite'), db = new DatabaseSync(referenceDatabase);
  db.exec('CREATE TABLE perf_SmallRows (ID INTEGER PRIMARY KEY, groupNo INTEGER, value INTEGER, text TEXT)');
  const insert = db.prepare('INSERT INTO perf_SmallRows VALUES (?,?,?,?)');
  for (const row of table.sample) insert.run(row.ID, row.groupNo, row.value, row.text);
  db.close();
  const calls = [], persisted = new Map(table.sample.map(row => [row.ID, row]));
  const listener = http.createServer(async (req, res) => {
    let text = ''; for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : null;
    calls.push(req.method + ' ' + req.url);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/benchmark/NoHandlerSmallRows')) return res.end(JSON.stringify({ value: table.sample.map(row => ({ ...row, checksum: null })) }));
    if (req.url === '/benchmark/noop') { res.statusCode = 204; return res.end(); }
    if (req.method === 'POST' && req.url === '/benchmark/NoHandlerWriteRows') { persisted.set(body.ID, body); res.statusCode = 201; return res.end(JSON.stringify(body)); }
    const ID = Number(req.url.match(/\((\d+)\)$/)?.[1]);
    if (req.method === 'PATCH') persisted.set(ID, { ...persisted.get(ID), ...body });
    res.end(JSON.stringify(persisted.get(ID)));
  });
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  try {
    const server = { url: 'http://127.0.0.1:' + listener.address().port, state: { plugins: [], annotations: [], engine: null }, runtime: { expectedHandlers: [] } };
    const validation = await verifyScenario(server, scenario({ operation: 'read', rows: 2, mixed: true }), fixture, { rollback: false, referenceDatabase });
    assert.equal(validation.passed, true);
    assert.ok(calls.some(call => call === 'POST /benchmark/NoHandlerWriteRows'));
    assert.ok(calls.some(call => call.startsWith('PATCH /benchmark/NoHandlerWriteRows')));
    assert.ok(calls.some(call => call === 'POST /benchmark/noop'));
    assert.equal(validation.mixedOperations.length, 3);
  } finally { await new Promise(done => listener.close(done)); await rm(root, { recursive: true, force: true }); }
});

test('fixed CAP and WASM endpoints share each server and preserve persistence, callbacks and rollback', async () => {
  const { APP_ROOT, loadFixture, deploy } = await import('../bench/fixture.mjs');
  const { startServer } = await import('../bench/process.mjs');
  const { verifyScenario } = await import('../bench/verify.mjs');
  const { executeRun, sourceHashes } = await import('../bench/run.mjs');
  const frozen = await loadFixture();
  const before = await sourceHashes();
  const logs = await mkdtemp(resolve(APP_ROOT, '.integration-test-'));
  let index = 0;
  try {
    for (const plain of [true, false]) {
      if (!plain) await deploy();
      const server = await startServer({ root: plain ? resolve(APP_ROOT, 'apps/cap') : APP_ROOT }, resolve(logs, plain ? 'cap' : 'oyster'), { diagnostics: true });
      const pid = server.child.pid;
      try {
        if (!plain) assert.equal(server.state.annotations.length, 27);
        const modes = plain ? ['cap-baseline'] : ['oyster-idle', 'native-empty', 'wasm-empty', 'native-compute', 'wasm-compute', 'native-compute-read', 'wasm-compute-read', 'native-compute-write', 'wasm-compute-write'];
        for (const mode of modes) for (const operation of ['action', 'create', 'update', 'read']) {
          const s = scenario({ mode, operation });
          const caseFixture = { ...frozen, createOffset: index++ * 3200000 };
          const validation = await verifyScenario(server, s, caseFixture, { diagnostics: true, rollback: operation === 'create' });
          assert.equal(validation.passed, true);
          if (operation === 'create') assert.equal(validation.rollback.passed, true);
          if (operation === 'update') {
            const next = await verifyScenario(server, s, caseFixture, { diagnostics: true, rollback: false, iteration: 80001 });
            assert.notEqual(next.persistedID, validation.persistedID);
          }
        }
        if (!plain) {
          for (const mode of modes.filter(mode => !mode.includes('idle'))) {
            await verifyScenario(server, scenario({ mode, hook: true }), frozen, { diagnostics: true, rollback: false });
          }
          for (const mode of ['native-compute', 'wasm-compute'])
            await verifyScenario(server, scenario({ mode, operation: 'scan' }), frozen, { diagnostics: true, rollback: false });
          for (const mode of ['native-compute-read', 'native-compute-write'])
            await verifyScenario(server, scenario({ mode, access: 'db' }), frozen, { diagnostics: true, rollback: false });
          for (const mode of ['native-compute-read', 'wasm-compute-read', 'native-compute-write', 'wasm-compute-write'])
            await verifyScenario(server, scenario({ mode, callbacks: 10 }), frozen, { diagnostics: true, rollback: false });
          for (const mode of ['native-compute-read', 'wasm-compute-read']) {
            const checksums = [];
            for (const lookupPattern of ['individual', 'batch']) {
              const check = await verifyScenario(server, scenario({ mode, lookupPattern }), frozen, { diagnostics: true, rollback: false });
              checksums.push(check.checksum);
              assert.equal(check.queries.filter(q => q.query?.SELECT).length, lookupPattern === 'batch' ? 1 : 10);
            }
            assert.equal(checksums[0], checksums[1], 'batching must preserve the business result');
          }
          for (const mode of ['oyster-idle', 'native-empty', 'wasm-empty'])
            await verifyScenario(server, scenario({ mode, operation: 'read', table: 'LargeRows', rows: 1000 }), frozen, { diagnostics: true, rollback: false });
          for (const hook of [false, true])
            await verifyScenario(server, scenario({ mode: 'oyster-idle', hook, hookControl: true }), frozen, { diagnostics: true, rollback: false });
          // Measures real HTTP traffic through the stdin worker without changing app source.
          const rawDir = resolve(logs, 'http');
          await mkdir(rawDir, { recursive: true });
          const records = await executeRun({ scenario: scenario({ mode: 'wasm-compute-write' }), repetition: 1, transport: 'http', load: { kind: 'vus', value: 1 } },
            { server, fixture: frozen, settings: { warmup: 1, duration: 1 }, rawDir, prefix: 'fixed-endpoint' });
          assert.equal(records.length, 1);
          assert.equal(records[0].validation.passed, true, records[0].error);
          assert.ok(records[0].stats.successes > 0);
          assert.equal(records[0].stats.errors, 0);
        }
        assert.equal(server.child.pid, pid);
        assert.equal(server.alive, true);
      } finally { await server.stop(); }
    }
    assert.deepEqual(await sourceHashes(), before, 'benchmark must never rewrite application or handler source');
  } finally { await rm(logs, { recursive: true, force: true }); }
});
