const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { sourceHashes } = require('../bench/run.js');
const { scenario } = require('../bench/scenarios.js');
const { oysterHandler } = require('../bench/report-view.js');

test('source evidence records the canonical extension base and resolves the relocated handler links', async () => {
  const hashes = await sourceHashes();
  assert.ok(hashes['apps/extension/.base/index.csn']);
  assert.ok(hashes['apps/extension/srv/BenchmarkService/on-oysterValidation.js']);
  assert.ok(hashes['apps/provider/srv/lib/validation.js']);
  assert.equal(Object.keys(hashes).some(path => path.includes('/gen/')), false);
  const link = oysterHandler(scenario({ mode: 'wasm-validate', operation: 'action' }));
  const path = link.slice(link.indexOf('](') + 2, -1);
  assert.equal(existsSync(resolve(__dirname, '../reports/example', path)), true);
});
