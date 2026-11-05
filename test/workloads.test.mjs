import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../lib/workload.mjs').catch(() => ({}));

test('CPU workload produces a checked deterministic 31-bit result', () => {
  assert.equal(typeof api.cpu, 'function');
  assert.equal(api.cpu(7, 0), 7);
  assert.equal(api.cpu(7, 1), 118);
  assert.equal(api.cpu(7, 2), 2007);
  assert.equal(api.cpu(7, 1000), api.cpu(7, 1000));
  assert.ok(api.cpu(2147483647, 1000) >= 0);
});

test('auxiliary reads affect the result while issuing exactly the requested queries', async () => {
  assert.equal(typeof api.executeWork, 'function');
  const queries = [];
  const result = await api.executeWork({ seed: 7, iterations: 1, calls: 3, lookupID: 11, effectID: 22 }, {
    kind: 'read', read: async id => { queries.push(id); return 10; },
  });
  assert.equal(result, 148);
  assert.deepEqual(queries, [11, 11, 11]);
});

test('auxiliary writes use the selected effect key and observable computed value', async () => {
  assert.equal(typeof api.executeWork, 'function');
  const writes = [];
  assert.equal(await api.executeWork({ seed: 7, iterations: 1, calls: 2, effectID: 22 }, {
    kind: 'write', write: async (id, value) => writes.push({ id, value }),
  }), 118);
  assert.deepEqual(writes, [{ id: 22, value: 118 }, { id: 22, value: 118 }]);
});
