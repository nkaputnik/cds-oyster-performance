import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, renderReport } from '../bench/report.mjs';
import { scenario } from '../bench/scenarios.mjs';

const manifest = { settings: { suite: 'matrix', warmup: 15, duration: 30, repetitions: 2 }, validation: { fixtureHashVerified: true } };
const fence = String.fromCharCode(96).repeat(3) + 'mermaid';
function run(mode, meanMs, extra = {}, repetition = 1) {
  return { scenario: scenario({ operation: 'create', mode, ...extra }), repetition, phase: 'warm', transport: 'http',
    load: { kind: 'vus', value: 1 }, stats: { successes: 20, errors: 0, meanMs }, validation: { passed: true } };
}

test('overview leads with named charts, preserves paired overhead, and links the details', () => {
  const results = [run('native-empty', 10), run('wasm-empty', 15), run('native-empty', 20, {}, 2), run('wasm-empty', 30, {}, 2)];
  const report = buildReport(manifest, results);
  assert.equal(report, renderReport(manifest, results));
  assert.ok(report.startsWith('# CDS-Oyster performance results'));
  assert.ok(report.indexOf(fence) < report.indexOf('## What the results show'));
  assert.match(report, /INSERT: empty handler/);
  assert.match(report, /Native empty handler/);
  assert.match(report, /Oyster empty handler/);
  assert.match(report, /\+7\.5 ms \| \+50% \| 2/);
  assert.match(report, /\[Detailed results\]\(details.md\)/);
  assert.doesNotMatch(report, /operation=|table=|\b[CF]\d+\b|create\/WriteRows|\u2014/);
});

test('READs distinguish table size, query shape, batch and per-row CQL counts', () => {
  for (const [enrichment, expected] of [['batch', '2 auxiliary CQL reads per request'], ['per-row', '2 auxiliary CQL reads for every returned row']]) {
    const extra = { operation: 'read', table: 'LargeRows', rows: 10, enrichment, callbacks: 2, queryShape: 'offset', offset: 900000 };
    const report = buildReport(manifest, [run('native-compute-read', 10, extra), run('wasm-compute-read', 15, extra)]);
    assert.ok(report.includes(expected));
    assert.match(report, /million-row table/);
    assert.match(report, /offset of 900,000/);
    assert.match(report, /READ 10 rows from million-row table/);
  }
});

test('empty handler descriptions do not claim calculations and tiny differences stay nonzero', () => {
  const report = buildReport(manifest, [run('native-empty', 0.000001), run('wasm-empty', 0.000002)]);
  assert.match(report, /\+0\.000001 ms/);
  assert.doesNotMatch(report, /calculation runs/);
});

test('invalid, skipped, truncated, and mismatched results cannot establish overhead', () => {
  for (const variant of [{ error: 'failed' }, { validation: { passed: false } }, { validation: { skipped: true } },
    { stats: { successes: 20, errors: 0, meanMs: 15, sampleLimitReached: true } }, { repetition: 2 }]) {
    const report = buildReport(manifest, [run('native-empty', 10), { ...run('wasm-empty', 15), ...variant }]);
    assert.match(report, /no valid matched comparison/);
    assert.doesNotMatch(report, /Extra time when using Oyster/);
  }
  const report = buildReport({ ...manifest, validation: { passed: false } }, [run('native-empty', 10), run('wasm-empty', 15)]);
  assert.match(report, /recorded validation failed/);
});

test('whole-scan chart leads with total seconds and excludes invocation timing from the overview', () => {
  const extra = { operation: 'scan', scanRows: 50000, scanCoordination: 'external', wholeScanRows: 1000000 };
  const results = [{ ...run('native-compute', 60, extra), wholeScanElapsedSeconds: 1.2 },
    { ...run('wasm-compute', 700, extra), wholeScanElapsedSeconds: 14 }];
  const report = buildReport(manifest, results);
  assert.ok(report.indexOf('## Processing the whole million-row table') < report.indexOf(fence));
  assert.ok(report.indexOf(fence) < report.indexOf('## What the results show'));
  assert.match(report, /bar \[1\.2, 14\]/);
  assert.match(report, /\+12\.8 seconds/);
  assert.doesNotMatch(report, /bar \[60, 700\]/);
});

test('missing data produces no invented chart or numeric observations', () => {
  const report = buildReport(manifest, []);
  assert.match(report, /no valid matched comparison/);
  assert.ok(!report.includes(fence));
  assert.doesNotMatch(report, /NaN|Infinity|undefined/);
});

test('standalone findings cite measured native/Oyster CPU, CQL, loops and heavy-load evidence', () => {
  const results = [];
  for (const operation of ['create', 'update', 'read', 'action']) {
    for (const [mode, ms] of [['cap-baseline', 5], ['oyster-idle', 6], ['native-empty', 7], ['wasm-empty', 10],
      ['native-compute', 10], ['wasm-compute', 20], ['native-compute-read', 15], ['wasm-compute-read', 30],
      ['native-compute-write', 18], ['wasm-compute-write', 38]]) results.push(run(mode, ms, { operation, actionContract: 'compute' }));
  }
  for (const [mode, ms] of [['native-compute-read', 12], ['native-compute-write', 13]])
    results.push(run(mode, ms, { operation: 'action', actionContract: 'compute', access: 'db' }));
  for (const rows of [10, 1000]) for (const [mode, factor] of [['native-compute', 1], ['wasm-compute', 2]])
    results.push(run(mode, rows * factor, { operation: 'read', table: 'LargeRows', rows }));
  results.push(run('native-compute', 100, { operation: 'scan', scanRows: 10000 }),
    run('wasm-compute', 250, { operation: 'scan', scanRows: 10000 }));
  for (const [mode, ms] of [['native-empty', 5], ['wasm-empty', 10], ['native-compute', 10], ['wasm-compute', 20],
    ['native-compute-read', 15], ['wasm-compute-read', 30]])
    results.push(run(mode, ms, { operation: 'action', actionContract: 'compute', hook: true }));
  for (const value of [4, 16]) for (const mode of ['native-compute', 'wasm-compute']) results.push({
    ...run(mode, value, { operation: 'action' }), load: { kind: 'vus', value },
    stats: { successes: 100, errors: 0, droppedIterations: 0, meanMs: value, p95Ms: value * 2, successfulRps: 100 / value },
    probe: { p95Ms: value / 2 }, resources: { clientCpuPercent: 25 },
  });
  const report = buildReport(manifest, results);
  assert.match(report, /## What the results show/);
  assert.doesNotMatch(report, /six questions|original question|hook flag|workload dimensions/i);
  for (const term of ['Cloud Application Programming Model', 'WebAssembly', 'query language', 'CQL callback', 'extension point', '95th-percentile', 'local SQLite']) assert.ok(report.includes(term), term);
  assert.match(report, /Benchmark setup and interpretation/);
  for (const question of ['Cost of native custom logic', 'Cost of moving logic into Oyster', 'Cost of enabling and invoking Oyster', 'Cost of database callbacks', 'Cost of processing larger results', 'Behavior under concurrent load'])
    assert.ok(report.includes('| ' + question + ' |'), question);
  const answers = report.split('## What the results show')[1].split(/\n## /)[0];
  assert.doesNotMatch(answers, /Unanswered: no eligible/);
  assert.match(answers, /\+5 ms/);
  assert.match(report, /\+150 ms/);
  assert.match(report, /direct database/i);
  assert.match(report, /Calling predefined extension points/);
  assert.match(report, /1,000-row table/);
  assert.match(report, /million-row table/);
  assert.match(report, /Unrelated probe p95/);
  assert.match(report, /Dropped starts/);
  assert.ok(report.split('\n').length <= 230);
  assert.match(report, /\[README\]\(\.\.\/\.\.\/README\.md\)/);
});

test('missing controls leave every finding and extension-point comparison explicitly unmeasured', () => {
  const report = buildReport(manifest, []);
  const answers = report.split('## What the results show')[1]?.split(/\n## /)[0] || '';
  assert.equal((answers.match(/\| Not measured:/g) || []).length, 6);
  assert.match(report, /Calling predefined extension points/);
  assert.match(report, /CQL read: not measured/i);
  assert.match(report, /CQL update: not measured/i);
});

test('late load failures remain visible and never become successful latency or overhead', () => {
  const result = { ...run('wasm-compute', 999, { operation: 'action' }), load: { kind: 'rate', value: 200 },
    stats: { successes: 20, errors: 2, droppedIterations: 7, meanMs: 999, p95Ms: 1500, successfulRps: 3 },
    probe: { p95Ms: 2 } };
  const report = buildReport(manifest, [result]);
  assert.match(report, /Failed/);
  assert.match(report, /200 requests\/s/);
  assert.match(report, /\| 3 \|.*\| 2 \| 7 \|/);
  assert.doesNotMatch(report, /bar \[999\]|bar \[1500\]/);
  assert.match(report, /Not measured:/);
});

test('a failed duplicate cannot rescue a matching repetition or inflate independent metrics', () => {
  const report = buildReport(manifest, [run('native-empty', 10), run('wasm-empty', 15),
    { ...run('native-empty', 9), validation: { passed: false } }]);
  assert.match(report, /no valid matched comparison/);
  assert.doesNotMatch(report, /\+5 ms/);
});

test('all benchmark findings have measured results for a complete protocol', () => {
  const results = [];
  for (const operation of ['create', 'update', 'read', 'action'])
    for (const [mode, mean] of [['cap-baseline', 5], ['oyster-idle', 6], ['native-empty', 6], ['wasm-empty', 8], ['native-compute', 10], ['wasm-compute', 20], ['native-compute-read', 15], ['wasm-compute-read', 30], ['native-compute-write', 15], ['wasm-compute-write', 30]])
      results.push(run(mode, mean, { operation }));
  results.push(run('native-compute-read', 12, { operation: 'action', access: 'db' }), run('native-compute-write', 12, { operation: 'action', access: 'db' }));
  for (const scanRows of [10000, 50000]) results.push(run('native-compute', scanRows / 100, { operation: 'scan', scanRows }), run('wasm-compute', scanRows / 50, { operation: 'scan', scanRows }));
  for (const value of [8, 32]) for (const mode of ['cap-baseline', 'native-compute-read', 'wasm-compute-read'])
    results.push({ ...run(mode, 20, { operation: 'action' }), load: { kind: 'vus', value }, stats: { successes: 20, errors: 0, meanMs: 20, p95Ms: value * 2, successfulRps: 100 } });
  const report = buildReport({ ...manifest, settings: { suite: 'short', repetitions: 1 } }, results);
  const answers = report.split('## What the results show')[1].split(/\n## /)[0];
  assert.doesNotMatch(answers, /Not measured|Unanswered/);
  assert.match(report, /Extra callback cost/);
  assert.match(report, /\+8 ms/);
});

test('the heavy-load table retains both concurrency levels for the same workload', () => {
  const results = [8, 32].map(value => ({ ...run('wasm-compute-read', value, { operation: 'action' }),
    load: { kind: 'vus', value }, stats: { successes: 100, errors: 0, meanMs: value, p95Ms: value * 2, successfulRps: 100 / value } }));
  const report = buildReport(manifest, results);
  const loadTable = report.split('| Workload / execution |')[1].split('Throughput averages')[0];
  assert.match(loadTable, /32 concurrent clients/);
  assert.match(loadTable, /8 concurrent clients/);
});
