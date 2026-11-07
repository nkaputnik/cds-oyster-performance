const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile, mkdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { homedir } = require('node:os');
const { execFileSync } = require('node:child_process');
test('runner build ships explicit shared source and production dependencies without a hosted CAP service', async () => {
  const parent = resolve(homedir(), 'git/clean-room/cds-oyster-performance-tests');
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(resolve(parent, 'runner-build-test-'));
  try {
    execFileSync(process.execPath, [resolve(__dirname, '../apps/runner/build.js'), scratch]);
    const pkg = JSON.parse(await readFile(resolve(scratch, 'package.json')));
    assert.ok(pkg.dependencies.autocannon); assert.equal(pkg.dependencies['@sap/cds'], undefined);
    for (const file of ['task.js', 'stage.js', 'Procfile', 'bench/load-worker.js', 'bench/cloud/run.js',
      'apps/provider/srv/lib/resources.js', 'apps/provider/srv/lib/workload.js', 'apps/extension/srv/BenchmarkService/on-oysterNoop.js']) assert.ok((await readFile(resolve(scratch, file))).length);
    assert.equal(pkg.type, undefined);
    execFileSync(process.execPath, [resolve(scratch, 'task.js'), '--help'], { env: { ...process.env, NODE_PATH: resolve(__dirname, '../node_modules') } });
    assert.match(await readFile(resolve(scratch, 'build-manifest.json'), 'utf8'), /sourceHashes/);
    await writeFile(resolve(scratch, 'stale-source.js'), 'stale'); await mkdir(resolve(scratch, 'node_modules')); await writeFile(resolve(scratch, 'node_modules/stale.txt'), 'stale');
    execFileSync(process.execPath, [resolve(__dirname, '../apps/runner/build.js'), scratch]);
    const rebuilt = JSON.parse(await readFile(resolve(scratch, 'build-manifest.json')));
    assert.equal(rebuilt.sourceHashes['stale-source.js'], undefined);
    assert.equal(rebuilt.sourceHashes['node_modules/stale.txt'], undefined);
    assert.equal(rebuilt.sourceHashes['build-manifest.json'], undefined);
    try { const lock = await readFile(resolve(__dirname, '../apps/runner/package-lock.json')); assert.deepEqual(await readFile(resolve(scratch, 'package-lock.json')), lock); assert.ok(rebuilt.runnerDependencyLockSha256); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
