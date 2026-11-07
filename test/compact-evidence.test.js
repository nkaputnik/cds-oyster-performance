const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const { mkdir, mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { resolve } = require('node:path');
const { homedir } = require('node:os');
const { executeCommand } = require('../bench/process.js');
const { scenario } = require('../bench/scenarios.js');
const { buildReport, buildDetailedReport } = require('../bench/report.js');
const scratch = resolve(homedir(), 'git/clean-room/oyster-report-packaging-20261107');
test('compact evidence preserves measurements, failure flags and chart data without response or fixture copies', () => {
  const modulePath = resolve(__dirname, '../bench/evidence-format.js');
  assert.ok(existsSync(modulePath), 'Compact evidence representation required');
  const { compactManifest, compactResult } = require(modulePath);
  const repeated = 'x'.repeat(1024 * 1024);
  const manifest = { id: 'test', settings: { suite: 'short' }, runOrder: [1, 2], artifacts: [1],
    environment: { execution: 'cloud', dependencies: {}, sourceHashes: { 'handler.js': 'hash' } },
    fixture: { valid: true, hashes: { 'rows.csv': 'hash' }, tables: { LargeRows: { count: 1000000, canonicalHash: 'canonical', sample: [repeated], ids: [1, 2] } } } };
  const records = ['native-empty', 'wasm-empty'].map((mode, i) => ({ scenario: scenario({ mode }),
    transport: 'http', phase: 'warm', repetition: 1, load: { kind: 'vus', value: 1 },
    stats: { successes: 100, errors: 0, meanMs: i + 0.123456789, p95Ms: i + 0.987654321, successfulRps: 100 },
    resources: { rssPeakMiB: 80 }, generatorResources: { rssPeakMiB: 40 },
    activeState: { instance: { ID: 'instance' }, extensionHealthy: true, configuration: repeated },
    cloudPostflightState: { instance: { ID: 'instance' }, extensionHealthy: true, configuration: repeated },
    rawFile: 'raw/test.json', validation: { passed: true, measuredWritesUnchanged: true,
      preflight: { passed: true, checksum: 123, activation: { handlerActive: true }, response: { body: repeated }, rollback: { passed: true, insertedRowAbsent: true } } } }));
  const compact = records.map(compactResult), metadata = compactManifest(manifest);
  assert.ok(JSON.stringify({ metadata, compact }).length < 10000);
  assert.deepEqual(compact[1].stats, records[1].stats);
  assert.deepEqual(compact[1].generatorResources, records[1].generatorResources);
  assert.equal(compact[1].validation.preflight.checksum, 123);
  assert.equal(compact[1].validation.preflight.rollback.insertedRowAbsent, true);
  assert.equal(compact[1].cloudPostflightState.instance.ID, 'instance');
  assert.equal(compact[1].validation.measuredWritesUnchanged, true);
  assert.equal(compact[1].rawFile, undefined);
  assert.equal(metadata.fixture.tables.LargeRows.count, 1000000);
  assert.deepEqual(metadata.environment.sourceHashes, manifest.environment.sourceHashes);
  assert.equal(metadata.runOrder, undefined);
  const fence = String.fromCharCode(96).repeat(3);
  const diagrams = text => text.split(fence + 'mermaid').slice(1).map(block => block.split(fence)[0]);
  for (const render of [buildReport, buildDetailedReport])
    assert.deepEqual(diagrams(render(manifest, records)), diagrams(render(metadata, compact)));
  const failed = compactResult({ ...records[0], error: 'bad result', validation: { passed: false, handlerBlocked: true } });
  assert.equal(failed.validation.handlerBlocked, true);
  assert.equal(failed.rawFile, 'raw/test.json');
  const rejected = compactResult({ validation: { passed: true, preflight: { passed: true, status: 400,
    response: { body: { error: { message: 'Amount exceeds limit', code: '400' } } } } } });
  assert.equal(rejected.validation.preflight.rejectionMessage, 'Amount exceeds limit');
  assert.equal(rejected.validation.preflight.response, undefined);
});
test('successful captured commands retain CPU accounting without writing files; failed commands keep diagnostics', async t => {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(resolve(scratch, 'capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await executeCommand(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({value:42}))'],
    { captureOutput: true, logPrefix: resolve(directory, 'success'), measureCpu: true });
  assert.equal(result.code, 0);
  assert.equal(typeof result.stdout, 'string', 'Captured output required');
  assert.equal(JSON.parse(result.stdout).value, 42);
  assert.deepEqual(await readdir(directory), []);
  assert.ok(result.clientCpuPercent === null || result.clientCpuPercent >= 0);
  const failed = await executeCommand(process.execPath, ['-e', 'process.stderr.write("diagnostic");process.exit(1)'],
    { captureOutput: true, logPrefix: resolve(directory, 'failed') });
  assert.equal(failed.code, 1);
  assert.match(await readFile(failed.stderrPath, 'utf8'), /diagnostic/);
});
test('captured commands retain graceful shutdown diagnostics after cancellation', async t => {
  const directory = await mkdtemp(resolve(scratch, 'cancel-capture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const command = executeCommand(process.execPath, ['-e',
    'process.on("SIGTERM",()=>{process.stdout.write("shutdown summary");process.stderr.write("shutdown diagnostic");process.exit(1)});setInterval(()=>{},1000)'],
    { captureOutput: true, logPrefix: resolve(directory, 'cancelled'), timeoutMs: 1000 });
  await assert.rejects(command, /timed out/);
  assert.match(await readFile(resolve(directory, 'cancelled.stdout.log'), 'utf8'), /shutdown summary/);
  assert.match(await readFile(resolve(directory, 'cancelled.stderr.log'), 'utf8'), /shutdown diagnostic/);
});
