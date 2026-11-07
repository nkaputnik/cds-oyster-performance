const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const { homedir } = require('node:os');
const { existsSync } = require('node:fs');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const cds = require('@sap/cds');

test('local and cloud samplers share one unchanged implementation', () => {
  assert.equal(require('../bench/resources.js').ResourceSampler, require('../apps/provider/srv/lib/resources.js').ResourceSampler);
});
test('admin control compiles for HANA and production bundle includes its resource and fixture helpers', async () => {
  const root = resolve(__dirname, '..');
  const model = await cds.load(resolve(root, 'apps/provider/srv'));
  const ddl = cds.compile.to.sql(model, { dialect: 'hana' });
  assert.ok(ddl.some(sql => sql.includes('benchmark_control_CampaignLease')));
  assert.ok(ddl.some(sql => sql.includes('benchmark_control_RestoreJobs')));
  assert.equal(model.definitions.BenchmarkAdminService['@requires'], 'BenchmarkAdministrator');
  assert.equal(model.definitions.BenchmarkAdminService['@extensible.code'], undefined);
  assert.equal(Object.keys(model.definitions).some(name => name.startsWith('BenchmarkService.') && name.includes('CampaignLease')), false);
  const scratch = resolve(homedir(), 'git/clean-room/oyster-btp-implementation-20261106');
  await mkdir(scratch, { recursive: true });
  const bundle = await mkdtemp(resolve(scratch, 'admin-build-'));
  try {
    execFileSync(process.execPath, [resolve(root, 'node_modules/@sap/cds-dk/bin/cds.js'), 'build', 'apps/provider', '--production', '--for', 'nodejs', '--dest', bundle], { cwd: root });
    for (const helper of ['resources.js', 'fixture-data.js', 'fixture-reference.js', 'cloud-control.js', 'provider-state.js'])
      assert.equal(existsSync(resolve(bundle, 'srv/lib', helper)), true, helper);
    assert.equal(existsSync(resolve(bundle, 'srv/admin-service.js')), true);
  } finally { await rm(bundle, { recursive: true, force: true }); }
});
