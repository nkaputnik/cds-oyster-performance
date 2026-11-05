import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpu } from '../lib/workload.mjs';
import { requestFor } from './requests.mjs';
import { loadFixture, DATABASE_PATH, APP_ROOT } from './fixture.mjs';
import { prepareRuntime, cleanupRuntime } from './prepare.mjs';
import { startServer } from './process.mjs';

const scalar = body => body && typeof body === 'object' && 'value' in body ? body.value : body;
const computing = s => s.mode.includes('compute');
const active = s => !s.hookControl && (s.hook || computing(s));
const keyValue = (fixture, table, ID) => {
  const row = fixture.tables[table].sample.find(row => row.ID === ID);
  assert.ok(row, 'Fixture value unavailable for auxiliary key ' + ID);
  return row.value;
};

function expectedWork(s, fixture, seed, lookupID = fixture.tables.LookupRows.ids[0], { iterations = s.iterations, calls = s.callbacks } = {}) {
  if (!computing(s)) return seed;
  let value = cpu(seed, iterations);
  if (s.mode.endsWith('-read'))
    for (let i = 0; i < calls; i++) value = (value + keyValue(fixture, 'LookupRows', lookupID)) & 2147483647;
  return value;
}

export function validateActivation(s, state, expectedHandlers = []) {
  const oyster = state.plugins?.includes('@sap/cds-oyster');
  if (s.mode === 'cap-baseline') assert.equal(oyster, false, 'CAP baseline must omit Oyster');
  else {
    assert.equal(oyster, true, 'Oyster plugin must be active');
    assert.equal(state.engine, 'oyster', 'Actual Oyster engine must be the WASM oyster engine');
    assert.ok(state.limits, 'Actual Oyster limits must be recorded');
  }
  assert.equal(state.annotations?.length ?? 0, expectedHandlers.length, 'Activated handler count');
  for (const filename of expectedHandlers) {
    const parts = filename.split('/');
    const [phase, event] = parts.pop().replace(/\.js$/, '').split('-');
    const name = parts.length === 2 ? parts[0] + '.' + parts[1] : parts[0] + '.' + event;
    assert.ok(state.annotations.some(a => a.name === name && a.phase === phase && a.event === event), 'Expected activated handler ' + filename);
  }
  return { passed: true, handlerActive: true, engine: state.engine, limits: state.limits,
    plugins: state.plugins, annotations: state.annotations, expectedHandlers };
}

function readRequestSpec(s, request) {
  const url = new URL(request.path, 'http://benchmark');
  const spec = { shape: s.queryShape || 'page', rows: Number(url.searchParams.get('$top') || s.rows), offset: Number(url.searchParams.get('$skip') || 0) };
  if (spec.shape === 'key') {
    const match = url.pathname.match(/\((\d+)\)$/);
    assert.ok(match, 'Key READ request must identify an actual fixture key');
    spec.ID = Number(match[1]); spec.rows = 1;
  }
  if (spec.shape === 'range') {
    const match = url.searchParams.get('$filter')?.match(/^ID ge (\d+) and ID le (\d+)$/);
    assert.ok(match, 'Indexed range READ request must provide ID bounds');
    spec.startID = Number(match[1]); spec.endID = Number(match[2]);
  }
  if (spec.shape === 'non-indexed') {
    const match = url.searchParams.get('$filter')?.match(/^groupNo eq (\d+)$/);
    assert.ok(match, 'Non-indexed READ request must provide a fixture groupNo');
    spec.groupNo = Number(match[1]);
  }
  return spec;
}

const readResponseRows = (s, body) => s.queryShape === 'key' ? (Array.isArray(body) ? body : body ? [body] : []) : scalar(body);

export function validateResponse(s, fixture, request, response, { scanChecksum, readRows } = {}) {
  assert.equal(response.status, request.expectedStatus, 'Unexpected public response status: ' + JSON.stringify(response.body));
  const validation = { passed: true, status: response.status };
  if (s.operation === 'action' && request.path.endsWith('/compute')) {
    const expected = expectedWork(s, fixture, request.body.seed, request.body.lookupID, request.body);
    assert.equal(scalar(response.body), expected, 'Action checksum');
    validation.checksum = expected;
  }
  if (s.operation === 'action' && request.path.endsWith('/noop')) assert.equal(response.status, 204, 'No-op must return 204');
  if (s.operation === 'read') {
    const rows = readResponseRows(s, response.body);
    assert.ok(Array.isArray(rows), 'READ response must be rows');
    const spec = readRequestSpec(s, request), table = fixture.tables[s.table];
    let ids = table.ids;
    if (spec.shape === 'key') ids = [spec.ID];
    else if (spec.shape === 'range') ids = ids.filter(ID => ID >= spec.startID && ID <= spec.endID).slice(0, spec.rows);
    else if (spec.shape === 'non-indexed') ids = readRows?.map(row => row.ID) || [];
    else ids = ids.slice(spec.offset, spec.offset + spec.rows);
    if (readRows) assert.equal(rows.length, readRows.length, 'READ reference row count');
    else if (spec.shape === 'non-indexed') assert.ok(rows.length > 0 && rows.length <= spec.rows, 'Filtered READ row count');
    else assert.equal(rows.length, spec.shape === 'key' ? 1 : spec.shape === 'range' ? ids.length : Math.min(spec.rows, Math.max(0, table.count - spec.offset)), 'READ row count');
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (i < ids.length) assert.equal(row.ID, ids[i], 'READ ordered fixture identity');
      if (i > 0) assert.ok(row.ID > rows[i - 1].ID, 'READ ordered fixture identity');
      if (spec.shape === 'range') assert.ok(row.ID >= spec.startID && row.ID <= spec.endID, 'READ indexed range identity');
      if (spec.shape === 'non-indexed') assert.equal(row.groupNo, spec.groupNo, 'READ non-indexed group filter');
      const sample = readRows?.[i] || table.sample.find(sample => sample.ID === row.ID);
      if (readRows) assert.equal(row.ID, sample.ID, 'READ reference fixture identity');
      if (sample) for (const name of ['groupNo', 'value', 'text']) assert.equal(row[name], sample[name], 'READ fixture ' + name);
      if (active(s)) {
        let expected;
        if (s.hook) expected = (cpu(row.value, s.iterations) + expectedWork(s, fixture, rows[0]?.value ?? 0)) & 2147483647;
        else if (s.enrichment === 'per-row') expected = expectedWork(s, fixture, row.value);
        else expected = (cpu(row.value, s.iterations) + expectedWork(s, fixture, 0, undefined, { iterations: 0, calls: s.callbacks })) & 2147483647;
        assert.equal(row.checksum, expected, 'READ checksum for ID ' + row.ID);
      } else assert.ok(row.checksum === null || row.checksum === undefined, 'Inactive READ must leave virtual checksum empty');
    }
    validation.rows = rows.length; validation.checksumsVerified = active(s) ? rows.length : 0;
    validation.queryShape = spec.shape; validation.offset = spec.offset; validation.referenceRowsVerified = readRows?.length ?? null;
  }
  if (s.operation === 'scan') {
    assert.ok(Number.isInteger(scanChecksum), 'Scan reference checksum is required');
    assert.equal(scalar(response.body), scanChecksum, 'Scan checksum');
    validation.checksum = scanChecksum; validation.rows = s.scanRows;
  }
  return validation;
}

export async function publicRequest(server, request, { timeoutMs = 120000, signal } = {}) {
  const start = performance.now();
  const response = await fetch(server.url + request.path, { method: request.method, headers: request.headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let body = text;
  if (text) { try { body = JSON.parse(text); } catch { /* Preserve non-JSON errors verbatim. */ } }
  else body = null;
  return { status: response.status, body, durationMs: performance.now() - start };
}

export async function scanReference(s, { database = DATABASE_PATH } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  let checksum = 0, count = 0;
  try {
    const statement = db.prepare('SELECT ID, value FROM perf_LargeRows ORDER BY ID LIMIT ?');
    for (const row of statement.iterate(s.scanRows)) { checksum = (checksum + cpu(row.value, s.iterations)) & 2147483647; count++; }
    assert.equal(count, s.scanRows, 'Reference scan row count');
    return checksum;
  } finally { db.close(); }
}

export async function readReference(s, fixture, request = requestFor(s, fixture), { database = DATABASE_PATH } = {}) {
  assert.ok(['SmallRows', 'LargeRows', 'WriteRows'].includes(s.table), 'Reference READ table must be known');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(database, { readOnly: true });
  const spec = readRequestSpec(s, request), values = [];
  let where = '';
  if (spec.shape === 'key') { where = ' WHERE ID = ?'; values.push(spec.ID); }
  if (spec.shape === 'range') { where = ' WHERE ID >= ? AND ID <= ?'; values.push(spec.startID, spec.endID); }
  if (spec.shape === 'non-indexed') { where = ' WHERE groupNo = ?'; values.push(spec.groupNo); }
  try {
    return db.prepare('SELECT ID, groupNo, value, text FROM perf_' + s.table + where + ' ORDER BY ID LIMIT ? OFFSET ?').all(...values, spec.rows, spec.offset);
  } finally { db.close(); }
}

export async function verifyRollback(server, fixture, { iteration = 8500000, signal } = {}) {
  const ID = Math.max(0, fixture.tables.WriteRows.maxID) + 1000000 + 10000000 + iteration;
  const effectID = fixture.tables.SideEffectRows.ids[0];
  const get = path => publicRequest(server, { method: 'GET', path, headers: { Accept: 'application/json' } }, { signal });
  const before = await get('/benchmark/SideEffectRows(' + effectID + ')');
  assert.equal(before.status, 200, 'Rollback auxiliary row must exist');
  const response = await publicRequest(server, { method: 'POST', path: '/benchmark/rollbackProbe',
    headers: { 'Content-Type': 'application/json' }, body: { ID, effectID, value: 123456 } }, { signal });
  assert.equal(response.status, 409, 'Rollback action must reject with 409');
  const inserted = await get('/benchmark/WriteRows(' + ID + ')'), after = await get('/benchmark/SideEffectRows(' + effectID + ')');
  assert.equal(inserted.status, 404, 'Rejected transaction must not persist its inserted row');
  assert.equal(after.body.value, before.body.value, 'Rejected transaction must roll back its auxiliary update');
  return { passed: true, rejectionStatus: response.status, insertedRowAbsent: true, auxiliaryUnchanged: true, response };
}

export async function verifyScenario(server, s, fixture, { transport = 'http', diagnostics = false, rollback = true, iteration = 8000000, signal, referenceDatabase } = {}) {
  assert.ok(!s.expectedFailure, 'Limit probes cannot pass normal correctness preflight');
  const activation = validateActivation(s, server.state, server.runtime.expectedHandlers);
  const request = requestFor(s, fixture, { iteration });
  if (diagnostics) await publicRequest(server, { method: 'POST', path: '/__benchmark/diagnostics/reset' }, { signal });
  const response = await publicRequest(server, request, { signal });
  const scanChecksum = s.operation === 'scan' ? await scanReference(s) : undefined;
  const readRows = s.operation === 'read' ? await readReference(s, fixture, request, { database: referenceDatabase }) : undefined;
  const validation = { ...validateResponse(s, fixture, request, response, { scanChecksum, readRows }), activation, response };
  if (diagnostics) {
    const callbacks = await publicRequest(server, { method: 'GET', path: '/__benchmark/callbacks' }, { signal });
    assert.equal(callbacks.status, 200, 'Callback diagnostics must be available');
    validation.callbacks = callbacks.body;
    validation.callbackBytes = callbacks.body.resultBytes;
    let expected = s.expectedCallbacks ?? 0;
    if (s.mode.startsWith('wasm-') && (s.mode.endsWith('-read') || s.mode.endsWith('-write'))
      && s.operation === 'read' && !s.hook && s.enrichment === 'per-row')
      expected = (readRows?.length ?? s.rows) * s.callbacks;
    assert.equal(callbacks.body.count, expected, 'Actual sandbox SELECT/write callback count');
    validation.callbackCountVerified = true;
    validation.resultBytes = Buffer.byteLength(JSON.stringify(response.body));
  }
  if (s.operation === 'create' || s.operation === 'update') {
    const ID = s.operation === 'create' ? request.body.ID : Number(request.path.match(/\((\d+)\)$/)[1]);
    const persisted = await publicRequest(server, { method: 'GET', path: '/benchmark/WriteRows(' + ID + ')', headers: { Accept: 'application/json' } }, { signal });
    assert.equal(persisted.status, 200, 'Written row must persist through transaction completion');
    const expected = active(s) ? expectedWork(s, fixture, 7, request.body.lookupID) : 7;
    assert.equal(persisted.body.value, expected, 'Persisted write checksum');
    validation.persistedValue = expected; validation.persistedID = ID;
  }
  if (computing(s) && s.mode.endsWith('-write') && s.callbacks > 0 && s.operation !== 'scan') {
    let expected = cpu(7, s.iterations);
    if (s.operation === 'read') {
      const rows = readResponseRows(s, response.body);
      expected = s.hook ? cpu(rows[0]?.value ?? 0, s.iterations)
        : s.enrichment === 'per-row' ? (rows.length ? cpu(rows[rows.length - 1].value, s.iterations) : keyValue(fixture, 'SideEffectRows', fixture.tables.SideEffectRows.ids[0])) : 0;
    }
    const persisted = await publicRequest(server, { method: 'GET', path: '/benchmark/SideEffectRows(' + fixture.tables.SideEffectRows.ids[0] + ')', headers: { Accept: 'application/json' } }, { signal });
    assert.equal(persisted.status, 200, 'Auxiliary write row must exist');
    assert.equal(persisted.body.value, expected, 'Auxiliary write must persist');
    validation.auxiliaryValue = expected;
  }
  if (rollback) validation.rollback = await verifyRollback(server, fixture, { signal });
  if (s.mixed) {
    validation.mixedOperations = [];
    for (const operation of ['create', 'update', 'action']) {
      const member = { ...s, mixed: false, operation, table: operation === 'action' ? s.readTable || 'SmallRows' : 'WriteRows' };
      validation.mixedOperations.push({ operation, validation: await verifyScenario(server, member, fixture,
        { transport, rollback: false, iteration, signal, referenceDatabase }) });
    }
  }
  if (diagnostics) {
    const queries = await publicRequest(server, { method: 'GET', path: '/__benchmark/queries', headers: { Accept: 'application/json' } }, { signal });
    assert.equal(queries.status, 200, 'Diagnostics must be available in verification runtime');
    validation.queryCount = queries.body.length; validation.queries = queries.body;
  }
  return validation;
}

async function main() {
  const { parseArgs, planRuns } = await import('./run.mjs');
  const settings = parseArgs(['--suite', 'short', '--repetitions', '1', ...process.argv.slice(2)]);
  if (settings.help) { console.log('npm run verify -- --suite short|long --filter REGEX'); return; }
  const fixture = await loadFixture();
  const id = 'verify-' + new Date().toISOString().replace(/[:.]/g, '-');
  const root = resolve(APP_ROOT, 'reports', id);
  await mkdir(root, { recursive: true });
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Verification interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const results = [];
  try {
    for (const [index, run] of planRuns(settings).entries()) {
      if (run.scenario.expectedFailure) continue;
      controller.signal.throwIfAborted();
      const runtime = await prepareRuntime(run.scenario, fixture, { diagnostics: true, signal: controller.signal });
      const server = await startServer(runtime, resolve(root, 'logs', String(index)), { signal: controller.signal });
      try {
        console.log('Verify ' + run.transport + ' ' + run.scenario.id);
        const validation = await verifyScenario(server, run.scenario, fixture, { transport: run.transport, diagnostics: true, signal: controller.signal });
        results.push({ scenario: run.scenario, transport: run.transport, validation, runtime: runtime.root });
      } catch (error) { results.push({ scenario: run.scenario, transport: run.transport, validation: { passed: false }, error: error.message }); throw error; }
      finally { await server.stop(); await cleanupRuntime(); }
    }
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await writeFile(resolve(root, 'verification.json'), JSON.stringify({ settings, results }, null, 2) + '\n');
  }
  console.log('Correctness evidence: ' + resolve(root, 'verification.json'));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
