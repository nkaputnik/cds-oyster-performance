import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, buildDetailedReport } from '../bench/report.mjs';
import { scenario } from '../bench/scenarios.mjs';

const manifest = { settings: { suite: 'short', warmup: 2, duration: 4, repetitions: 1 }, validation: { passed: true }, finishedAt: '2026-11-05T17:23:00Z' };
const fence = String.fromCharCode(96).repeat(3) + 'mermaid';
const plain = report => report.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
function run(mode, meanMs, extra = {}, repetition = 1) {
  return { scenario: scenario({ operation: 'action', mode, ...extra }), repetition, phase: 'warm', transport: 'http',
    load: { kind: 'vus', value: 1 }, stats: { successes: 20, errors: 0, meanMs }, validation: { passed: true } };
}

test('report leads with evidence and explains measured costs and application design in neutral language', () => {
  const report = buildReport(manifest, [run('native-empty', 1), run('wasm-empty', 2)]);
  assert.ok(report.indexOf(fence) < report.indexOf('| Application design |'));
  for (const text of ['untrusted logic', 'WebAssembly', 'Cloud Application Programming Model', 'CQL callback',
    'Application design', 'What is the typical overhead', 'How does overhead change', 'Which patterns increase',
    'How do measured costs relate', 'Application design choices', 'JavaScript inside WebAssembly', 'Concurrent load', 'Evidence quality', 'One paired run', '[Detailed results](details.md)'])
    assert.ok(report.toLowerCase().includes(text.toLowerCase()), text);
  assert.doesNotMatch(report, /move.*untrusted.*native|How extension developers|extension authors|management takeaway|business-decision model|modest absolute|performance case is strongest|cost envelope|\*\*(Observed|Meaning|Implication|Assessment|What this teaches)|operation=|table=|\u2014/i);
  assert.ok(report.length < 26000);
});

test('paired overhead averages independent repetition deltas without losing tiny values', () => {
  const report = buildReport(manifest, [run('native-empty', 10), run('wasm-empty', 15), run('native-empty', 20, {}, 2), run('wasm-empty', 30, {}, 2)]);
  assert.ok(report.includes("+7.5 ms"));
  assert.ok(report.includes("| 15 | 22.5 | +7.5 | 1.5\u00d7 | 2 |"));
  assert.ok(buildReport(manifest, [run('native-empty', .000001), run('wasm-empty', .000002)]).includes("+0.000001 ms"));
});

test('missing, invalid, duplicate and mismatched runs cannot support findings or charts', () => {
  for (const change of [{ error: 'failure' }, { validation: { passed: false } }, { validation: { skipped: true } },
    { stats: { successes: 20, errors: 0, meanMs: 2, sampleLimitReached: true } }, { repetition: 2 },
    { scenario: scenario({ mode: 'wasm-empty', iterations: 200 }) }]) {
    const report = buildReport(manifest, [run('native-empty', 1), { ...run('wasm-empty', 2), ...change }]);
    assert.ok(report.includes("no valid matched comparison"));
    assert.ok(!report.includes(fence));
  }
  const duplicates = [run('native-empty', 1), run('wasm-empty', 2), { ...run('native-empty', 3), validation: { passed: false } }];
  assert.ok(!buildReport(manifest, duplicates).includes(fence));
  assert.ok(!buildReport({ ...manifest, validation: { passed: false } }, [run('native-empty', 1), run('wasm-empty', 2)]).includes(fence));
  assert.doesNotMatch(buildReport(manifest, []), /NaN|Infinity|undefined/);
});

test('bulk findings distinguish returned rows, stored table size and missing controls', () => {
  const extra = { operation: 'read', table: 'LargeRows', rows: 1000 };
  const report = buildReport(manifest, [run('native-compute', 2, extra), run('wasm-compute', 20, extra)]);
  assert.ok(report.includes("READ 1,000 rows from million-row table"));
  assert.ok(report.includes("+18 ms (10\u00d7 native time)"));
  assert.ok(report.includes("cannot separate result handling"));
  assert.doesNotMatch(report, /Empty handlers skip/);
  const controls = buildReport(manifest, [run('native-empty', 1, extra), run('wasm-empty', 10, extra), run('native-compute', 2, extra), run('wasm-compute', 20, extra)]);
  assert.ok(controls.includes("changed Oyster time by +10 ms and native time by +1 ms"));
});

test('whole-dataset results use matched total seconds, not individual invocation latency', () => {
  const extra = { operation: 'scan', scanRows: 50000, scanCoordination: 'external', wholeScanRows: 1000000 };
  const report = buildReport(manifest, [{ ...run('native-compute', 60, extra), wholeScanElapsedSeconds: 1.2 }, { ...run('wasm-compute', 700, extra), wholeScanElapsedSeconds: 14 }]);
  assert.ok(report.includes('bar [1.2, 14]'));
  assert.ok(report.includes("+12.8 seconds"));
  assert.ok(!report.includes('bar [60, 700]'));
});

test('within-Oyster batching preserves the task and reports actual savings or regressions', () => {
  const results = [run('wasm-compute-read', 10, { lookupPattern: 'individual' }), run('wasm-compute-read', 4, { lookupPattern: 'batch' })];
  const report = buildReport(manifest, results);
  assert.ok(report.includes("Equivalent lookup enrichment inside Oyster"));
  assert.ok(report.includes("same 10 distinct keys, columns, arithmetic and scalar result"));
  assert.ok(report.includes("-6 ms (-60%)"));
  assert.ok(report.includes("Batching reduced time"));
  assert.ok(buildReport(manifest, [results[0], run('wasm-compute-read', 12, { lookupPattern: 'batch' })]).includes("Batching did not reduce time"));
  const mismatch = [results[0], run('wasm-compute-read', 4, { lookupPattern: 'batch', iterations: 200 })];
  assert.ok(buildReport(manifest, mismatch).includes("matched individual-versus-batch lookup runs are missing"));
});

test('callback marginal cost uses four matching runs and nine extra statements', () => {
  const results = [];
  for (const repetition of [1, 2]) for (const callbacks of [1, 10])
    for (const [mode, ms] of [['native-compute-read', callbacks === 1 ? 2 : 11], ['wasm-compute-read', callbacks === 1 ? 5 : 32]])
      results.push(run(mode, ms * repetition, { callbacks }, repetition));
  assert.ok(plain(buildReport(manifest, results)).includes("| CQL read | 1.5 | 4.5 | +3 | 2 |"));
  for (const variant of [results.slice(1), [...results, { ...results[0], validation: { passed: false } }]])
    assert.ok(plain(buildReport(manifest, variant)).includes("| CQL read | 2 | 6 | +4 | 1 |"));
  assert.ok(buildReport(manifest, []).includes("matched 1-query and 10-query"));
});

function loaded(mode, clients, throughput, p95, cpu) {
  return { ...run(mode, p95 / 2), load: { kind: 'vus', value: clients },
    stats: { successes: 100, errors: 0, meanMs: p95 / 2, p95Ms: p95, successfulRps: throughput }, resources: { cpuPercent: cpu } };
}

test('load analysis relates throughput plateau, p95 and matched CPU cost', () => {
  const results = [loaded('native-compute-read', 8, 1000, 2, 100), loaded('wasm-compute-read', 8, 500, 4, 200),
    loaded('native-compute-read', 32, 1000, 6, 100), loaded('wasm-compute-read', 32, 500, 12, 200)];
  const report = buildReport(manifest, results);
  assert.ok(report.includes("throughput changed 0%; p95 changed from 4 to 12 ms"));
  assert.ok(report.includes("Additional concurrency did not increase observed Oyster throughput"));
  assert.ok(plain(report).includes("CPU cost per successful request was 1 ms native and 4 ms Oyster (4\u00d7)"));
  assert.ok(report.includes("bar [1000, 500, 1000, 500]"));
  assert.ok(report.includes("horizontal scaling across servers"));
  assert.ok(report.includes("closed-loop"));
});

test('load analysis never mixes workloads, kinds or repetitions and surfaces failures', () => {
  const a = loaded('native-compute-read', 8, 1000, 2, 100), b = loaded('wasm-compute-read', 8, 500, 4, 200);
  const other = { ...loaded('wasm-compute-read', 32, 500, 999, 200), scenario: scenario({ mode: 'wasm-compute-read', callbacks: 10 }) };
  const report = buildReport(manifest, [a, b, other]);
  assert.ok(report.includes("across loads are missing"));
  assert.ok(!report.includes('999'));
  const failed = { ...loaded('wasm-compute-read', 32, 3, 999, 200), stats: { successes: 20, errors: 2, meanMs: 999, p95Ms: 999, successfulRps: 3, droppedIterations: 7 } };
  const failures = buildReport(manifest, [failed]);
  assert.ok(failures.includes("| 3 | 2 | 7 |"));
  assert.ok(failures.includes("higher-load failures: 1"));
  assert.ok(!failures.includes(fence));
});

test('every individual use-case comparison remains in the detailed catalog with stable colors', () => {
  const results = [];
  for (const operation of ['create', 'update', 'read', 'action'])
    for (const [mode, ms] of [['cap-baseline', 1], ['oyster-idle', 2], ['native-empty', 3], ['wasm-empty', 4], ['native-compute', 5], ['wasm-compute', 6], ['native-compute-read', 7], ['wasm-compute-read', 8]])
      results.push(run(mode, ms, { operation }));
  const report = buildDetailedReport(manifest, results);
  for (const name of ['INSERT', 'UPDATE', 'READ 10 rows from 1,000-row table', 'Action']) assert.ok(report.includes(name + ' without callbacks'), name);
  assert.ok(report.includes('bar [1, 2, 3, 4, 5, 6]'));
  assert.ok(report.includes('rect:nth-child(3) { fill: #2563eb; stroke: #2563eb; }'));
  assert.ok(report.includes('rect:nth-child(4) { fill: #ea580c; stroke: #ea580c; }'));
  assert.doesNotMatch(buildReport(manifest, results), /### INSERT without callbacks/);
});

test('load trends require common independent repetitions at every load', () => {
  const at8 = [loaded('native-compute-read', 8, 1000, 2, 100), loaded('wasm-compute-read', 8, 500, 4, 200)];
  const at32 = [loaded('native-compute-read', 32, 1000, 6, 100), loaded('wasm-compute-read', 32, 100, 12, 200)]
    .map(r => ({ ...r, repetition: 2 }));
  const disjoint = buildReport(manifest, [...at8, ...at32]);
  assert.ok(disjoint.includes('across loads are missing'));
  assert.ok(!disjoint.includes('throughput changed -80%'));
  const common = [loaded('native-compute-read', 8, 800, 2, 100), loaded('wasm-compute-read', 8, 400, 4, 200)]
    .map(r => ({ ...r, repetition: 2 }));
  const report = buildReport(manifest, [...at8, ...common, ...at32]);
  assert.ok(report.includes('throughput changed -75%'));
  assert.ok(report.includes('bar [800, 400, 1000, 100]'));
});

test('large READ findings link directly to the Oyster calculation and empty handlers', () => {
  const extra = { operation: 'read', table: 'LargeRows', rows: 1000 };
  const report = buildReport(manifest, [run('native-empty', 1, extra), run('wasm-empty', 10, extra), run('native-compute', 2, extra), run('wasm-compute', 20, extra)]);
  assert.ok(report.includes('[READ 1,000 rows from million-row table](../../srv/BenchmarkService/OysterCalculationLargeRows/after-READ.js) added **+18 ms (10× native time)**'));
  assert.ok(report.includes('[empty Oyster handler](../../srv/BenchmarkService/OysterEmptyLargeRows/after-READ.js)'));
});

test('Oyster source links resolve CRUD events, action variants, extension points and mixed work', () => {
  const cases = [
    ['wasm-empty', { operation: 'create' }, 'BenchmarkService/OysterEmptyWriteRows/before-CREATE.js'],
    ['wasm-compute', { operation: 'update' }, 'BenchmarkService/OysterCalculationWriteRows/before-UPDATE.js'],
    ['wasm-compute-read', { operation: 'read', table: 'SmallRows' }, 'BenchmarkService/OysterCqlReadSmallRows/after-READ.js'],
    ['wasm-compute-write', { operation: 'read', table: 'LargeRows' }, 'BenchmarkService/OysterCqlWriteLargeRows/after-READ.js'],
    ['wasm-empty', {}, 'BenchmarkService/on-oysterNoop.js'],
    ['wasm-compute', {}, 'BenchmarkService/on-oysterCalculation.js'],
    ['wasm-compute-read', {}, 'BenchmarkService/on-oysterCqlRead.js'],
    ['wasm-compute-write', {}, 'BenchmarkService/on-oysterCqlWrite.js'],
    ['wasm-empty', { hook: true }, 'BenchmarkExtensionService/on-oysterEmpty.js'],
    ['wasm-compute', { hook: true }, 'BenchmarkExtensionService/on-oysterCalculation.js'],
    ['wasm-compute-read', { hook: true }, 'BenchmarkExtensionService/on-oysterCqlRead.js'],
    ['wasm-compute-write', { hook: true }, 'BenchmarkExtensionService/on-oysterCqlWrite.js'],
    ['wasm-compute', { operation: 'scan' }, 'BenchmarkService/on-oysterScan.js'],
    ['wasm-compute-read', { lookupPattern: 'individual' }, 'BenchmarkService/on-oysterLookupIndividual.js'],
    ['wasm-compute-read', { lookupPattern: 'batch' }, 'BenchmarkService/on-oysterLookupBatch.js'],
  ];
  for (const [mode, extra, path] of cases) {
    const report = buildDetailedReport(manifest, [run(mode, 2, extra)]);
    assert.ok(report.includes('](../../srv/' + path + ')'), path);
    assert.ok(!report.includes(String.fromCharCode(92) + '](../../srv/' + path + ')'), 'source links must render as Markdown links');
  }
  const mixed = buildDetailedReport(manifest, [run('wasm-compute-read', 2, { operation: 'read', mixed: true })]);
  for (const path of ['OysterCqlReadSmallRows/after-READ.js', 'OysterCqlReadWriteRows/before-CREATE.js', 'OysterCqlReadWriteRows/before-UPDATE.js', 'on-oysterCqlRead.js'])
    assert.ok(mixed.includes('](../../srv/BenchmarkService/' + path + ')'), path);
  const controls = buildDetailedReport(manifest, [run('cap-baseline', 1), run('oyster-idle', 1)]);
  assert.doesNotMatch(controls, /\]\(\.\.\/\.\.\/srv\//);
});

test('application overview shows per-call costs and one explicit request-time illustration', () => {
  const hook = { hook: true, actionContract: 'compute' };
  const whole = { operation: 'scan', scanCoordination: 'external', wholeScanRows: 1000000 };
  const results = [run('native-compute', 1, hook), run('wasm-compute', 2, hook),
    run('native-compute-read', 2, hook), run('wasm-compute-read', 3.5, hook),
    { ...run('native-compute', 60, whole), wholeScanElapsedSeconds: 1.2 },
    { ...run('wasm-compute', 700, whole), wholeScanElapsedSeconds: 14 }];
  const report = buildReport(manifest, results);
  const overview = plain(report.split('## 1.')[0]);
  for (const text of ['Application-level impact', 'native handlers',
    'custom entities', 'after-READ', 'Illustrative request',
    '100 ms', '101.5 ms', 'baseline is assumed', 'CPU demand', 'registration and startup',
    'One small extension-point call added +1 to +1.5 ms', 'Equivalent native handler'])
    assert.ok(overview.includes(text), text);
  assert.doesNotMatch(overview, /20%|100\.3 ms|first-order estimate|traffic share|Defined points are not calls|Requests pay|invokes only one|budget its latency/);
  assert.ok(report.indexOf('Predefined extension point: request time') < report.indexOf('Processing the whole million-row table'));
  assert.ok(report.includes('](../../srv/BenchmarkExtensionService/on-oysterCqlRead.js)'));
});

test('custom-entity additions compare Oyster handlers with no handler rather than native business logic', () => {
  const extra = { operation: 'update' };
  const report = buildReport(manifest, [run('oyster-idle', 1, extra), run('native-compute', 100, extra), run('wasm-compute', 3, extra)]);
  const overview = plain(report.split('## 1.')[0]);
  assert.ok(overview.includes('UPDATE: +2 ms'));
  assert.ok(overview.includes('Oyster enabled and no handler'));
  assert.ok(!overview.includes('UPDATE: -97 ms'));
  assert.ok(!overview.includes('100.3 ms'));
});
