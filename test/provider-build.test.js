const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { existsSync } = require('node:fs');

test('production provider includes the libraries required by its native services', () => {
  const root = resolve(__dirname, '..');
  execFileSync(process.execPath, [resolve(root, 'node_modules/@sap/cds-dk/bin/cds.js'), 'build', 'apps/provider', '--production'], { cwd: root });
  const bundle = resolve(root, 'apps/provider/gen/srv');
  assert.equal(typeof require(resolve(bundle, 'srv/benchmark-service.js')), 'function');
  assert.equal(typeof require(resolve(bundle, 'srv/extension-service.js')), 'function');
  assert.equal(existsSync(resolve(bundle, 'srv/BenchmarkService')), false);
  assert.equal(existsSync(resolve(bundle, 'srv/BenchmarkExtensionService')), false);
});
