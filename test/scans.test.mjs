import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { SELECT } from '../node_modules/@sap/cds-oyster/lib/engines/framework/ql/lib/ql/select.js';
import { readFile } from 'node:fs/promises';
import { scenario } from '../bench/scenarios.mjs';
import { cpu } from '../lib/workload.mjs';

test('sandbox keyset scan builds greater-than predicates and advances over sparse pages', async () => {
  const rows = [{ ID: 11, value: 7 }, { ID: 12, value: 8 }, { ID: 14, value: 9 }];
  const queries = [];
  SELECT.prototype.then = function(resolve) {
    queries.push(JSON.parse(JSON.stringify(this)));
    const [ref, operator, val] = this.SELECT.where;
    assert.deepEqual(ref, { ref: ['ID'] });
    assert.equal(operator, '>', 'Oyster restricted QL must preserve the cursor comparison');
    return Promise.resolve(rows.filter(row => row.ID > val.val).slice(0, this.SELECT.limit.rows.val)).then(resolve);
  };
  const s = scenario({ mode: 'wasm-compute', operation: 'scan', scanRows: 3, pageSize: 2, iterations: 3 });
  const source = await readFile(new URL('../srv/BenchmarkService/on-oysterScan.js', import.meta.url), 'utf8');
  const context = { module: { exports: null }, SELECT };
  vm.runInNewContext(source, context);
  const value = await context.module.exports.call({ entities: { NoHandlerLargeRows: { name: 'BenchmarkService.NoHandlerLargeRows' } } },
    { data: { cursor: 10, count: 3, pageSize: 2, iterations: s.iterations }, reject: (_, message) => { throw new Error(message); } });
  assert.equal(value, rows.reduce((sum, row) => (sum + cpu(row.value, 3)) & 2147483647, 0));
  assert.deepEqual(queries.map(q => q.SELECT.where[2].val), [10, 12]);
});
