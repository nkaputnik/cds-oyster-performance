const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { readFile } = require('node:fs/promises');
const api = require('../bench/requests.js');
const resources = require('../bench/resources.js');
const fixture = { tables: {
  SmallRows: { minID: 11, maxID: 99, ids: [11, 37, 99], count: 3, sample: [{ ID: 11, groupNo: 7 }, { ID: 37, groupNo: 3 }] },
  LargeRows: { minID: 21, maxID: 90000, ids: [21, 45], count: 10000 },
  WriteRows: { minID: 19, maxID: 83, ids: [19, 41, 83], count: 3 },
  LookupRows: { ids: [101, 203, 307] }, SideEffectRows: { ids: [109, 211, 313] },
} };
const base = { mode: 'cap-baseline', operation: 'action', table: 'SmallRows', rows: 2,
  iterations: 100, callbacks: 1, hook: false, scanRows: 1000, pageSize: 80 };

test('fast non-INSERT cases can rotate keys beyond the INSERT allocation partition', () => {
  for (const operation of ['action', 'read', 'update']) {
    assert.doesNotThrow(() => api.requestFor({ ...base, operation }, fixture, { iteration: 150000 }));
  }
  assert.throws(() => api.requestFor({ ...base, operation: 'create' }, fixture, { iteration: 150000 }), /allocation/);
});

test('individual and batch lookup actions use identical distinct rotating keys and payloads', () => {
  const s = { ...base, mode: 'wasm-compute-read', lookupPattern: 'individual', rows: 3 };
  const a = api.requestFor(s, fixture), b = api.requestFor({ ...s, lookupPattern: 'batch' }, fixture);
  assert.equal(a.path, '/benchmark/oysterLookupIndividual');
  assert.equal(b.path, '/benchmark/oysterLookupBatch');
  assert.deepEqual(a.body, b.body);
  assert.deepEqual(a.body.lookupIDs, [101, 203, 307]);
  assert.deepEqual(api.requestFor(s, fixture, { iteration: 1 }).body.lookupIDs, [203, 307, 101]);
  assert.throws(() => api.requestFor({ ...s, rows: 4 }, fixture), /lookup|keys/i);
});

test('writes use disjoint generated keys and enforce their integer allocation bounds', () => {
  assert.equal(typeof api.requestFor, 'function');
  const create = { ...base, operation: 'create', table: 'WriteRows' };
  const first = api.requestFor(create, fixture, { vu: 1, iteration: 0 });
  const next = api.requestFor(create, fixture, { vu: 1, iteration: 1 });
  const other = api.requestFor(create, fixture, { vu: 2, iteration: 0 });
  assert.equal(first.body.ID, 1100083);
  assert.equal(next.body.ID, 1100084);
  assert.equal(other.body.ID, 1200083);
  assert.deepEqual(first.body, { ID: 1100083, groupNo: 7, value: 7, text: 'benchmark', lookupID: 101, effectID: 109 });
  assert.equal(first.headers['Content-Type'], 'application/json');
  assert.equal(first.expectedStatus, 201);
  assert.throws(() => api.requestFor(create, { ...fixture, createOffset: 2147483647 }), /Integer|32-bit|range/);
  assert.throws(() => api.requestFor(create, fixture, { iteration: 100000 }), /iteration/);
  assert.throws(() => api.requestFor(create, fixture, { vu: 0 }), /vu/);
});

test('updates partition actual sparse fixture keys by virtual user', () => {
  const s = { ...base, operation: 'update', table: 'WriteRows' };
  assert.equal(api.requestFor(s, fixture, { vu: 1, iteration: 900 }).path, '/benchmark/NoHandlerWriteRows(19)');
  assert.equal(api.requestFor(s, fixture, { vu: 2, clients: 3 }).path, '/benchmark/NoHandlerWriteRows(41)');
  assert.deepEqual(api.requestFor(s, fixture).body, { value: 7, lookupID: 101, effectID: 109 });
  assert.throws(() => api.requestFor(s, fixture, { vu: 4 }), /fixture|partition/);
});

test('READ requests select checked fields, stable order and the requested row count', () => {
  const request = api.requestFor({ ...base, operation: 'read', table: 'LargeRows' }, fixture);
  const url = new URL(request.path, 'http://local');
  assert.equal(request.method, 'GET');
  assert.equal(url.pathname, '/benchmark/NoHandlerLargeRows');
  assert.equal(url.searchParams.get('$select'), 'ID,groupNo,value,text,checksum');
  assert.equal(url.searchParams.get('$orderby'), 'ID');
  assert.equal(url.searchParams.get('$top'), '2');
  assert.equal(request.expectedStatus, 200);
});

test('READ shapes use actual sparse keys, indexed ranges, non-indexed filters and offsets', () => {
  const read = { ...base, operation: 'read' };
  const key = new URL(api.requestFor({ ...read, queryShape: 'key' }, fixture, { vu: 2 }).path, 'http://local');
  assert.equal(key.pathname, '/benchmark/NoHandlerSmallRows(37)');
  assert.equal(key.searchParams.get('$select'), 'ID,groupNo,value,text,checksum');
  const range = new URL(api.requestFor({ ...read, queryShape: 'range' }, fixture, { vu: 2 }).path, 'http://local');
  assert.equal(range.searchParams.get('$filter'), 'ID ge 37 and ID le 99');
  const filter = new URL(api.requestFor({ ...read, queryShape: 'non-indexed' }, fixture, { vu: 2 }).path, 'http://local');
  assert.equal(filter.searchParams.get('$filter'), 'groupNo eq 3');
  const offset = new URL(api.requestFor({ ...read, queryShape: 'offset', offset: 900000, table: 'LargeRows' }, fixture).path, 'http://local');
  assert.equal(offset.searchParams.get('$skip'), '900000');
  for (const queryShape of ['page', 'key', 'range', 'non-indexed', 'offset']) {
    const a = api.requestFor({ ...read, mode: 'native-empty', queryShape, offset: queryShape === 'offset' ? 1 : 0 }, fixture);
    const b = api.requestFor({ ...read, mode: 'wasm-empty', queryShape, offset: queryShape === 'offset' ? 1 : 0 }, fixture);
    assert.deepEqual({ ...a, path: a.path.replace('NativeEmpty', 'OysterEmpty') }, b, queryShape);
  }
});

test('each handler uses a fixed projection or action endpoint', () => {
  assert.equal(api.requestFor(base, fixture).path, '/benchmark/noop');
  assert.equal(api.requestFor(base, fixture).expectedStatus, 204);
  for (const [mode, action] of [['native-empty', 'nativeEmptyExtension'], ['wasm-empty', 'oysterEmptyExtension'], ['wasm-compute-read', 'oysterCqlReadExtension']]) {
    const request = api.requestFor({ ...base, mode, hook: true }, fixture, { vu: 2, clients: 3 });
    assert.equal(request.path, '/benchmark/' + action);
    assert.deepEqual(request.body, { seed: 7, iterations: 100, calls: 1, lookupID: 203, effectID: 211 });
  }
  assert.equal(api.requestFor({ ...base, mode: 'wasm-compute-read' }, fixture).path, '/benchmark/oysterCqlRead');
});

test('writes rotate through seeded rows within disjoint client partitions', () => {
  const s = { ...base, operation: 'update', table: 'WriteRows' };
  assert.deepEqual([0, 1, 2, 3].map(iteration => api.requestFor(s, fixture, { iteration }).path),
    [19, 41, 83, 19].map(ID => '/benchmark/NoHandlerWriteRows(' + ID + ')'));
  assert.deepEqual([0, 1, 2].map(iteration => api.requestFor(s, fixture, { iteration }).body.effectID), [109, 211, 313]);
  const ids = Array.from({ length: 1000 }, (_, i) => i + 1);
  const large = { tables: Object.fromEntries(Object.keys(fixture.tables).map(name => [name, { ids, maxID: 1000 }])) };
  const partitions = Array.from({ length: 32 }, (_, i) => new Set(Array.from({ length: 31 }, (_, iteration) =>
    api.requestFor(s, large, { vu: i + 1, clients: 32, iteration }).path)));
  assert.equal(new Set(partitions.flatMap(set => [...set])).size, 992);
  const create = { ...s, operation: 'create' };
  assert.notEqual(api.requestFor(create, large).body.ID, api.requestFor(create, { ...large, createOffset: 3200000 }).body.ID);
});

test('scan uses a fixed action and starts before the first sparse key', () => {
  const scan = api.requestFor({ ...base, operation: 'scan', table: 'LargeRows' }, fixture);
  assert.equal(scan.path, '/benchmark/nativeScan');
  assert.deepEqual(scan.body, { cursor: 20, count: 1000, pageSize: 80, iterations: 100 });
  assert.equal(api.requestFor({ ...base, operation: 'scan', mode: 'wasm-compute' }, fixture).path, '/benchmark/oysterScan');
});

test('resource sampler records server RSS, CPU and event loop delay over one interval', async () => {
  assert.equal(typeof resources.ResourceSampler, 'function');
  const sampler = new resources.ResourceSampler({ intervalMs: 5, eventLoopResolutionMs: 2 });
  sampler.start();
  await delay(20);
  const result = sampler.stop();
  assert.ok(result.elapsedSeconds >= 0.015);
  assert.ok(result.rssPeakBytes >= result.rssStartBytes);
  assert.ok(result.cpuUserMs >= 0);
  assert.ok(result.cpuSystemMs >= 0);
  assert.ok(result.cpuPercent >= 0);
  assert.ok(result.eventLoopP95Ms >= 0);
  assert.ok(Number.isInteger(result.gcCount));
  assert.ok(result.gcDurationMs >= 0);
  assert.equal(result.gcMs, result.gcDurationMs);
  assert.equal(result.rssPeakMiB, result.rssPeakBytes / 1048576);
  assert.ok(result.eventLoopP99Ms >= 0);
});
