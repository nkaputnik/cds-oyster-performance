import test from 'node:test';
import assert from 'node:assert/strict';
const api = await import('../bench/scenarios.mjs').catch(() => ({}));

test('unknown modes and negative work sizes are rejected', () => {
  assert.equal(typeof api.scenario, 'function');
  assert.throws(() => api.scenario({ mode: 'unknown' }), /mode/);
  assert.throws(() => api.scenario({ iterations: -1 }), /iterations/);
  assert.throws(() => api.scenario({ callbacks: -1 }), /callbacks/);
});

test('paired native and WASM workloads have identical work parameters', () => {
  assert.equal(typeof api.scenario, 'function');
  const a = api.scenario({ mode: 'native-compute-read', operation: 'update', iterations: 100, callbacks: 5 });
  const b = api.scenario({ ...a, mode: 'wasm-compute-read' });
  for (const key of ['operation', 'table', 'rows', 'iterations', 'callbacks', 'access', 'hook'])
    assert.equal(a[key], b[key], key);
});

test('short covers every workload family and excludes expected failures', () => {
  assert.equal(typeof api.suite, 'function');
  const cases = api.suite('short');
  assert.ok(cases.some(s => s.mode === 'cap-baseline'));
  assert.ok(cases.some(s => s.mode === 'wasm-compute-write'));
  assert.ok(cases.some(s => s.hook));
  assert.ok(cases.some(s => s.operation === 'scan'));
  assert.ok(cases.every(s => !s.expectedFailure));
});

test('WASM budgets include per-row and scan callback totals', () => {
  assert.throws(() => api.scenario({ mode: 'wasm-compute-read', operation: 'read', rows: 1000, enrichment: 'per-row', callbacks: 1 }), /callback/i);
  assert.throws(() => api.scenario({ mode: 'wasm-compute', operation: 'scan', scanRows: 101000, pageSize: 1000 }), /callback/i);
  assert.equal(api.scenario({ mode: 'wasm-compute-read', operation: 'read', rows: 80, enrichment: 'per-row', callbacks: 1 }).expectedCallbacks, 80);
  assert.equal(api.scenario({ mode: 'wasm-compute', operation: 'scan', scanRows: 50000 }).expectedCallbacks, 50);
});

test('READ query shape and offset are validated and distinguish scenario identity', () => {
  const normal = api.scenario({ operation: 'read' });
  assert.equal(normal.queryShape, 'page');
  assert.equal(normal.offset, 0);
  assert.equal(api.scenario({ operation: 'read', queryShape: 'key' }).rows, 1);
  assert.notEqual(normal.id, api.scenario({ ...normal, queryShape: 'offset', offset: 900 }).id);
  assert.throws(() => api.scenario({ queryShape: 'unknown' }), /queryShape/);
  assert.throws(() => api.scenario({ offset: -1 }), /offset/);
  assert.throws(() => api.scenario({ queryShape: 'range', offset: 3 }), /offset/);
});

test('long adds bounded scans, CQL fan-out, and representative mixed traffic', () => {
  const cases = api.suite('long');
  assert.ok(cases.some(s => s.scanRows === 50000 && s.operation === 'scan'));
  assert.ok(cases.some(s => s.callbacks === 5 && s.mode === 'wasm-compute-read'));
  assert.ok(cases.some(s => s.mixed));
});
