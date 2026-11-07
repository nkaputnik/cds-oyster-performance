const test = require('node:test');
const assert = require('node:assert/strict');
const api = require('../bench/scenarios.js');
const { requestFor } = require('../bench/requests.js');

const fixture = { tables: {
  SmallRows: { ids: [1, 2] }, LargeRows: { minID: 1, ids: [1, 2] },
  WriteRows: { maxID: 100, ids: Array.from({ length: 64 }, (_, i) => i + 1) },
  LookupRows: { ids: Array.from({ length: 64 }, (_, i) => i + 101) },
  SideEffectRows: { ids: Array.from({ length: 64 }, (_, i) => i + 201) },
} };

function identity(s) {
  const { id, expectedCallbacks, benchmarkLoad, ...dimensions } = s;
  const load = benchmarkLoad || { kind: 'vus', value: 1 };
  return JSON.stringify([dimensions, load.kind, load.value]);
}

test('cloud presets retain all workloads in one Oyster-enabled runtime', () => {
  assert.equal(typeof api.cloudSuite, 'function');
  for (const [name, localCount, cloudCount] of [['short', 108, 102], ['long', 121, 115]]) {
    const local = api.suite(name);
    const cloud = api.cloudSuite(name);
    assert.equal(local.length, localCount, name + ' local count');
    assert.equal(cloud.length, cloudCount, name + ' cloud count');
    assert.ok(local.some(s => s.mode === 'cap-baseline'));
    assert.ok(cloud.every(s => s.mode !== 'cap-baseline'));
    assert.equal(new Set(cloud.map(identity)).size, cloud.length);
    for (const source of local) {
      const expected = api.scenario({ ...source, mode: source.mode === 'cap-baseline' ? 'oyster-idle' : source.mode });
      const selected = cloud.find(s => identity(s) === identity(expected));
      assert.ok(selected, name + ' ' + expected.id);
      assert.equal(selected.id, expected.id);
      assert.equal(selected.expectedCallbacks, expected.expectedCallbacks);
      assert.deepEqual(requestFor(selected, fixture), requestFor(source, fixture));
    }
  }
  assert.throws(() => api.cloudSuite('unknown'), /Unknown suite/);
});

test('cloud no-handler controls preserve ordinary, concurrent and mixed traffic', () => {
  assert.equal(typeof api.cloudSuite, 'function');
  for (const name of ['short', 'long']) {
    const cases = api.cloudSuite(name);
    for (const value of [8, 32]) {
      const s = cases.find(s => s.mode === 'oyster-idle' && s.operation === 'action' && !s.hook && s.benchmarkLoad?.value === value);
      assert.ok(s, name + ' action VUs ' + value);
      assert.deepEqual(s.benchmarkLoad, { kind: 'vus', value });
      assert.equal(requestFor(s, fixture).path, '/benchmark/noop');
    }
    assert.ok(cases.some(s => s.mode === 'oyster-idle' && s.operation === 'action' && !s.hook && !s.benchmarkLoad));
    for (const hook of [false, true])
      assert.ok(cases.some(s => s.mode === 'oyster-idle' && s.hookControl && s.hook === hook));
  }
  const long = api.cloudSuite('long');
  for (const mode of ['oyster-idle', 'native-compute-read', 'wasm-compute-read'])
    for (const value of [1, 8, 32]) {
      const mixed = long.find(s => s.mode === mode && s.operation === 'read' && s.mixed && s.benchmarkLoad?.value === value);
      assert.ok(mixed, mode + ' mixed VUs ' + value);
      assert.deepEqual(mixed.benchmarkLoad, { kind: 'vus', value });
      assert.ok(long.some(s => s.mode === mode && s.operation === 'read' && !s.mixed && !s.benchmarkLoad));
    }
});

test('cloud presets preserve accepted and rejected native and Oyster constraints', () => {
  assert.equal(typeof api.cloudSuite, 'function');
  for (const name of ['short', 'long']) {
    const cases = api.cloudSuite(name);
    assert.equal(cases.filter(s => s.validationOutcome).length, 32);
    for (const mode of ['native-validate', 'wasm-validate', 'native-validate-read', 'wasm-validate-read'])
      for (const validationOutcome of ['accepted', 'rejected'])
        for (const [operation, hook] of [['create', false], ['update', false], ['action', false], ['action', true]]) {
          const s = cases.find(s => s.mode === mode && s.validationOutcome === validationOutcome && s.operation === operation && s.hook === hook);
          assert.ok(s, [name, mode, validationOutcome, operation, hook].join(' '));
          assert.equal(s.iterations, 0);
          assert.equal(s.expectedCallbacks, mode === 'wasm-validate-read' ? 1 : 0);
          assert.equal(s.expectedFailure, null);
          const request = requestFor(s, fixture);
          assert.equal(request.body.quantity * request.body.unitPrice, validationOutcome === 'rejected' ? 2000 : 20);
          assert.equal(request.expectedStatus, validationOutcome === 'rejected' ? 400 : operation === 'create' ? 201 : 200);
        }
  }
});

test('cloud selection preserves callback budgets and independent request keys', () => {
  assert.equal(typeof api.cloudSuite, 'function');
  for (const name of ['short', 'long']) {
    const cases = api.cloudSuite(name);
    for (const s of cases) {
      assert.equal(s.expectedCallbacks, api.callbackBudget(s), s.id);
      assert.ok(s.expectedCallbacks <= 100);
    }
    const creates = cases.filter(s => s.operation === 'create');
    const allocated = new Set();
    for (const [index, s] of creates.entries()) for (const vu of [1, 32]) for (const iteration of [0, 50000, 99999]) {
      const request = requestFor(s, { ...fixture, createOffset: index * 3200000 }, { vu, clients: 32, iteration });
      assert.ok(!allocated.has(request.body.ID), s.id + ' duplicate INSERT key');
      allocated.add(request.body.ID);
    }
    const update = cases.find(s => s.mode === 'oyster-idle' && s.operation === 'update');
    const paths = [1, 32].flatMap(vu => [150000, 150001].map(iteration =>
      requestFor(update, fixture, { vu, clients: 32, iteration }).path));
    assert.equal(new Set(paths).size, paths.length);
  }
});

test('cloud selections return fresh workload and load objects', () => {
  assert.equal(typeof api.cloudSuite, 'function');
  const first = api.cloudSuite('long');
  const selected = first.find(s => s.benchmarkLoad);
  const originalID = selected.id;
  selected.benchmarkLoad.value = 999;
  selected.rows = 999;
  const second = api.cloudSuite('long');
  const unchanged = second.find(s => s.id === originalID && s.benchmarkLoad?.value === 8);
  assert.equal(unchanged.rows, 10);
  assert.equal(unchanged.benchmarkLoad.value, 8);
  assert.notStrictEqual(unchanged, selected);
  assert.notStrictEqual(unchanged.benchmarkLoad, selected.benchmarkLoad);
  assert.ok(api.suite('long').every(s => s.benchmarkLoad?.value !== 999));
});
