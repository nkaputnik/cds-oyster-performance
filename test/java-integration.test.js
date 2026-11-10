const test = require('node:test');
const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const { mkdir } = require('node:fs/promises');
const { DatabaseSync } = require('node:sqlite');
const { suite } = require('../bench/scenarios.js');
const { verifyScenario } = require('../bench/verify.js');
const { measureWholeScan } = require('../bench/whole-scan.js');
const { executeRun, parseArgs } = require('../bench/run.js');

test('local Java MTX lifecycle, all correctness cases, measurements and whole table', {
  skip: process.env.BENCHMARK_JAVA_TEST !== '1', timeout: 600000,
}, async () => {
  const { createJavaRuntime, JAVA_DATABASE } = require('../bench/java.js');
  const reportDir = resolve(__dirname, '../reports/java-verification');
  await mkdir(resolve(reportDir, 'raw'), { recursive: true });
  const signal = new AbortController().signal;
  const runtime = await createJavaRuntime({ logDir: resolve(reportDir, 'logs'), signal });
  try {
    const fixture = runtime.fixture;
    let server = await runtime.start();
    let count = 0;
    for (const scenario of suite('long').filter(s => s.mode !== 'cap-baseline')) {
      try { await verifyScenario(server, scenario, { ...fixture, createOffset: count++ * 3200000 }, { referenceDatabase: JAVA_DATABASE }); }
      catch (error) { error.message = scenario.id + ': ' + error.message; throw error; }
    }
    console.log('Java correctness cases:', count);
    const extensions = () => {
      const db = new DatabaseSync(JAVA_DATABASE, { readOnly: true });
      try { return JSON.stringify(db.prepare('SELECT * FROM cds_xt_Extensions').all()); }
      finally { db.close(); }
    };
    const before = extensions();
    await server.stop();
    await runtime.reset();
    assert.equal(extensions(), before, 'Reset preserves activated extensions');
    server = await runtime.start();
    const settings = parseArgs(['--runtime', 'java', '--warmup', '0', '--duration', '1']);
    for (const mode of ['native-compute-read', 'wasm-compute-read']) {
      const scenario = suite('short').find(s => s.operation === 'action' && !s.hook && s.mode === mode && (s.benchmarkLoad?.value ?? 1) === 1);
      const [result] = await executeRun({ scenario, repetition: 1, transport: 'http', load: { kind: 'vus', value: 32 } },
        { server, fixture, settings, rawDir: resolve(reportDir, 'raw'), prefix: mode, compactEvidence: true, referenceDatabase: JAVA_DATABASE });
      assert.equal(result.validation.passed, true, result.error);
      assert.ok(result.stats.successes > 0);
      assert.ok(result.resources.heapPeakMiB > 0);
      assert.equal(result.resources.rssPeakMiB, null);
    }
    const results = [];
    await measureWholeScan({ server, fixture, settings, reportDir, signal, results, database: JAVA_DATABASE, compactEvidence: true });
    assert.equal(results.length, 2);
    assert.ok(results.every(r => r.validation.passed), JSON.stringify(results.map(r => r.error)));
  } finally { await runtime.stop(); }
});
