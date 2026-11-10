const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs, planRuns, sourceHashes } = require('../bench/run.js');
const { validateActivation } = require('../bench/verify.js');
const { buildReport, buildDetailedReport } = require('../bench/report.js');
const { spawnSync } = require('node:child_process');
const { resolve } = require('node:path');

test('local runtime selection preserves Node defaults and accepts Java presets', () => {
  assert.equal(parseArgs([]).runtime, 'node');
  assert.equal(parseArgs(['--runtime', 'java']).runtime, 'java');
  assert.equal(parseArgs(['--runtime', 'java', '--suite', 'long']).suite, 'long');
  assert.throws(() => parseArgs(['--runtime', 'unknown']), /runtime/);
});

test('Node verification rejects Java selection before deploying or generating mislabeled evidence', () => {
  const result = spawnSync(process.execPath, [resolve(__dirname, '../bench/verify.js'), '--runtime', 'java'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Use npm run verify:java/);
});

test('cloud benchmarking rejects a local-only Java runtime before setup', async () => {
  const { runCloudBenchmark } = require('../bench/cloud/run.js');
  await assert.rejects(runCloudBenchmark(parseArgs(['--runtime', 'java'])), /Java benchmarks are local only/);
});

test('source evidence includes Java sources and excludes generated build output', async () => {
  const hashes = await sourceHashes();
  assert.ok(hashes['apps/provider-java/srv/src/main/java/org/capire/benchmark/BenchmarkHandler.java']);
  assert.ok(hashes['apps/provider-java/pom.xml']);
  assert.ok(hashes['apps/provider-java/srv/src/main/resources/application.yaml']);
  assert.ok(Object.keys(hashes).every(path => !/\/(target|gen|edmx)\//.test(path)));
});

test('activation validates the Java Oyster feature and requires the selected handler', () => {
  const state = { hostRuntime: 'java', engine: 'oyster', plugins: ['com.sap.cds:cds-feature-code-extensions'],
    annotations: [{ name: 'BenchmarkService.oysterCalculation', phase: 'on', event: 'oysterCalculation' }] };
  const scenario = { mode: 'wasm-compute', operation: 'action' };
  assert.equal(validateActivation(scenario, state).passed, true);
  assert.throws(() => validateActivation(scenario, { ...state, annotations: [] }), /handler/);
  assert.throws(() => validateActivation(scenario, { ...state, annotations: [...state.annotations, ...state.annotations] }), /exactly one/);
  assert.throws(() => validateActivation(scenario, { ...state, plugins: [] }), /active/);
});

test('Java reports identify native Java, its separate Oyster versions and JVM heap', () => {
  const manifest = { id: 'java-test', settings: { runtime: 'java', suite: 'short', repetitions: 1 },
    environment: { runtimes: { java: { versions: { java: '21', capJava: '5.2.0', codeExtensions: '5.2.0',
      oysterRuntime: '2.1.0', oysterFramework: '0.5.5', sqlite: '3.50' } } } } };
  const report = buildReport(manifest, []);
  assert.match(report, /native Java and JavaScript Oyster handlers/);
  assert.match(report, /benchmark:java/);
  assert.ok(report.includes('Oyster runtime / framework'));
  assert.ok(report.includes('2.1.0 / 0.5.5'));
  assert.doesNotMatch(report, /native reference executes in Node.js/);
  assert.match(buildDetailedReport(manifest, []), /Peak JVM heap/);
});

test('Java shares the applicable scenario matrix without a separate plugin-free control', () => {
  for (const suite of ['short', 'long']) {
    const node = planRuns(parseArgs(['--suite', suite]));
    const java = planRuns(parseArgs(['--suite', suite, '--runtime', 'java']));
    assert.ok(node.some(run => run.scenario.mode === 'cap-baseline'));
    assert.ok(java.every(run => run.scenario.mode !== 'cap-baseline'));
    assert.deepEqual(java.map(run => run.scenario.id).sort(),
      node.filter(run => run.scenario.mode !== 'cap-baseline').map(run => run.scenario.id).sort());
    assert.ok(java.some(run => run.scenario.mode === 'wasm-compute-write'));
    assert.ok(java.some(run => run.scenario.hook));
    assert.ok(java.some(run => run.scenario.validationOutcome === 'rejected'));
  }
});
