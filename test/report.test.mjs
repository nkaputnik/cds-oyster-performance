import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildDetailedReport as buildReport, writeReport } from '../bench/report.mjs';
import { scenario } from '../bench/scenarios.mjs';

const manifest = {
  id: 'test-run', startedAt: '2026-11-05T10:00:00Z',
  settings: { suite: 'smoke', warmupSeconds: 15, measureSeconds: 30, repetitions: 2, seed: 42 },
  environment: { node: 'v22', platform: 'test', arch: 'test', cpu: 'test cpu', packages: { cds: 'test' }, sourceRevision: 'test-revision', mermaid: null },
  fixture: { hash: 'test-hash', rowCounts: { SmallRows: 1000 }, journalMode: 'delete' },
  validation: { checksum: true },
};

function run(mode, meanMs, repetition = 1, scenario = {}, options = {}) {
  return {
    scenario: { id: `${mode}-${repetition}`, mode, operation: 'READ', table: 'SmallRows', rows: 10, iterations: 100, callbacks: 0, access: 'service', hook: 'after', ...scenario },
    repetition, transport: 'http', phase: 'warm', load: { kind: 'serial', value: 1 },
    stats: { samples: 20, successes: 20, errors: 0, droppedIterations: 0, meanMs, p50Ms: meanMs, p95Ms: meanMs * 2, p99Ms: meanMs * 3, successfulRps: 100, offeredRps: 100, completedRps: 100, elapsedSeconds: 30 },
    resources: { cpuPercent: null, rssPeakMiB: 25, eventLoopP99Ms: undefined, gcCount: null, gcMs: null, clientCpuPercent: null },
    rawFile: 'raw/test.json', ...options,
  };
}

function section(report, title) {
  const marker = `## ${title}\n`;
  assert.ok(report.includes(marker), `missing ${title}`);
  return report.split(marker)[1].split(/\n## /)[0];
}

function charts(report) {
  return [...report.matchAll(/```mermaid\n(xychart-beta[\s\S]*?)```/g)].map(match => match[1]);
}

test('detailed report reports missing observations honestly', () => {
  const report = buildReport(manifest, []);
  assert.match(report, /No measured runs/);
  assert.match(section(report, 'Findings'), /unanswered/i);
  assert.equal(charts(report).length, 0);
  assert.equal((report.match(/sequenceDiagram/g) || []).length, 3);
  assert.match(report, /\[Manifest\]\(manifest.json\)/);
  assert.match(report, /\[Results JSON\]\(results.json\)/);
  assert.doesNotMatch(report, /\u2014/);
});

test('missing latency and resources remain unavailable while measured zeros remain zero', () => {
  const result = run('native-empty', 1);
  result.stats.p95Ms = null;
  result.stats.p99Ms = undefined;
  result.resources.gcCount = 0;
  const report = buildReport(manifest, [result]);
  assert.match(section(report, 'Per-run latency and throughput'), /\| 1 \| unavailable \| unavailable \| 1 \|/);
  assert.match(section(report, 'Per-run resources'), /\| unavailable \| 25 \| unavailable \| 0 \| unavailable \| unavailable \|/);
  assert.doesNotMatch(report, /NaN|Infinity|undefined/);
});

test('zero-success failures never enter successful charts or matched findings', () => {
  const failed = run('wasm-empty', 999);
  failed.stats.successes = 0;
  failed.stats.errors = 20;
  failed.error = 'sandbox failed';
  const report = buildReport(manifest, [run('native-empty', 3), failed]);
  assert.match(section(report, 'Failures and limit probes'), /sandbox failed/);
  assert.doesNotMatch(charts(report).join('\n'), /999|wasm-empty/);
  assert.doesNotMatch(section(report, 'Findings'), /996/);
  assert.match(section(report, 'Findings'), /unanswered/i);
});

test('pairs run means by repetition and exact workload, reporting independent variability', () => {
  const results = [run('native-empty', 10, 1), run('wasm-empty', 14, 1), run('native-empty', 20, 2), run('wasm-empty', 26, 2)];
  results[1].stats.p95Ms = 999;
  const report = buildReport(manifest, results);
  const finding = section(report, 'Findings').split('\n').find(line => line.startsWith('| Sandbox path versus native handler |'));
  assert.ok(finding);
  assert.match(finding, /\| 2 \| 5 \| 35 \| 1\.414 \|/);
  assert.match(section(report, 'Independent repetition variability'), /\| native-empty \|.*\| 2 \| 15 \| 7\.071 \| 10 \| 20 \|/);
  assert.match(report, /Percentiles.*component distributions/i);
});

test('distinct dimensions and phases cannot collapse into a comparison', () => {
  const results = [
    run('native-compute', 10), run('wasm-compute', 40, 1, { rows: 100 }),
    run('wasm-compute', 50, 1, { table: 'LargeRows' }),
    run('wasm-compute', 60, 1, { iterations: 999 }),
    run('wasm-compute', 70, 1, { callbacks: 1 }),
    run('wasm-compute', 80, 1, { access: 'database' }),
    run('wasm-compute', 90, 1, { hook: 'before' }),
    run('wasm-compute', 100, 1, {}, { transport: 'service' }),
    run('wasm-compute', 110, 1, {}, { phase: 'cold' }),
    run('wasm-compute', 120, 1, {}, { load: { kind: 'vus', value: 4 } }),
    run('wasm-compute', 130, 2),
  ];
  const report = buildReport(manifest, results);
  const finding = section(report, 'Findings').split('\n').find(line => line.startsWith('| Execution-location penalty for CPU work |'));
  assert.match(finding, /unanswered/i);
  const groups = section(report, 'Independent repetition variability').split('\n').filter(line => line.startsWith('| wasm-compute |'));
  assert.equal(groups.length, 10);
});

test('validation and skipped handlers are separated from performance evidence', () => {
  const skipped = run('wasm-compute', 0.1, 1, {}, { probe: { handlerExecuted: false, skipped: true } });
  const report = buildReport({ ...manifest, validation: { handlerChecksum: false } }, [run('native-compute', 10), skipped]);
  assert.match(section(report, 'Handler and correctness validation'), /handlerChecksum.*false/);
  assert.match(section(report, 'Handler and correctness validation'), /handlerExecuted.*false/);
  assert.doesNotMatch(charts(report).join('\n'), /wasm-compute/);
  assert.match(section(report, 'Findings'), /unanswered/i);
});

test('failed manifest validation prevents measured performance claims', () => {
  const report = buildReport({ ...manifest, validation: { passed: false } }, [run('native-empty', 10), run('wasm-empty', 15)]);
  assert.equal(charts(report).length, 0);
  const finding = section(report, 'Findings').split('\n').find(line => line.startsWith('| Sandbox path versus native handler |'));
  assert.match(finding, /unanswered/i);
  assert.match(section(report, 'Handler and correctness validation'), /passed.*false/);
});

test('duplicate repetition IDs cannot inflate independent variability or paired evidence', () => {
  const report = buildReport(manifest, [run('native-empty', 10), run('native-empty', 12), run('wasm-empty', 15)]);
  const finding = section(report, 'Findings').split('\n').find(line => line.startsWith('| Sandbox path versus native handler |'));
  assert.match(finding, /unanswered/i);
  const native = section(report, 'Independent repetition variability').split('\n').find(line => line.startsWith('| native-empty |'));
  assert.match(native, /\| 0 \| unavailable \| unavailable \|/);
});

test('charts use one basic series and preserve scaling and load dimensions', () => {
  const results = [
    run('wasm-compute', 2, 1, { rows: 10 }),
    run('wasm-compute', 4, 1, { rows: 100 }),
    run('wasm-compute-read', 6, 1, { callbacks: 1 }),
    run('wasm-compute-read', 8, 1, { callbacks: 5 }),
    run('wasm-compute', 10, 1, {}, { load: { kind: 'arrival', value: 10 }, probe: { p95Ms: 2 } }),
    run('wasm-compute', 20, 1, {}, { load: { kind: 'arrival', value: 20 }, probe: { p95Ms: 3 } }),
  ];
  const report = buildReport(manifest, results);
  assert.match(report, /Returned-row scaling/);
  assert.match(report, /Callback fan-out/);
  assert.match(report, /Load latency/);
  assert.match(report, /Successful throughput/);
  assert.match(report, /Unrelated-request probe/);
  for (const chart of charts(report)) {
    assert.equal((chart.match(/^\s*(bar|line) /gm) || []).length, 1);
    assert.doesNotMatch(chart, /(?:bar|line) "/);
    assert.doesNotMatch(chart, /null|NaN|Infinity/);
  }
});

test('writes exact JSON and safely escaped CSV, Markdown and relative source links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oyster-report-test-'));
  try {
    const result = run('native-empty', 2, 1, { id: 'a,"b"\nc|d<script>' }, { rawFile: 'raw/a file (1).json', error: 'bad,"quote"\nnext' });
    const path = await writeReport(dir, manifest, [result]);
    assert.equal(path, join(dir, 'report.md'));
    assert.deepEqual((await readdir(dir)).sort(), ['details.md', 'manifest.json', 'report.md', 'results.csv', 'results.json']);
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')), manifest);
    const json = JSON.parse(await readFile(join(dir, 'results.json'), 'utf8'));
    assert.equal(json[0].scenario.id, result.scenario.id);
    const csv = await readFile(join(dir, 'results.csv'), 'utf8');
    assert.ok(csv.includes('"a,""b""\nc|d<script>"'));
    assert.ok(csv.includes('"bad,""quote""\nnext"'));
    assert.ok(csv.includes('unavailable'));
    const report = await readFile(join(dir, 'details.md'), 'utf8');
    assert.ok(report.includes('c\\|d&lt;script&gt;'));
    assert.ok(report.includes('raw/a%20file%20%281%29.json'));
    assert.doesNotMatch(report, /<script>|\u2014/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('CSV preserves numeric precision and tiny measured latency is not displayed as zero', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oyster-report-precision-'));
  try {
    const result = run('native-compute', 0.00000123456789);
    await writeReport(dir, manifest, [result]);
    const csv = await readFile(join(dir, 'results.csv'), 'utf8');
    assert.ok(csv.includes('0.00000123456789'));
    const report = await readFile(join(dir, 'details.md'), 'utf8');
    assert.match(section(report, 'Per-run latency and throughput'), /0\.00000123/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scan, enrichment and mixed workload dimensions remain distinct', () => {
  const variants = [{ pageSize: 500 }, { scanRows: 50000 }, { enrichment: 'per-row' }, { mixed: true }, { readTable: 'LargeRows' }];
  const results = [run('native-compute', 10), ...variants.map((s, i) => run('wasm-compute', 20 + i, 1, s))];
  const report = buildReport(manifest, results);
  const finding = section(report, 'Findings').split('\n').find(line => line.startsWith('| Execution-location penalty for CPU work |'));
  assert.match(finding, /unanswered/i);
  assert.equal(section(report, 'Independent repetition variability').split('\n').filter(line => line.startsWith('| wasm-compute |')).length, 5);
  for (const field of ['pageSize', 'scanRows', 'enrichment', 'mixed', 'readTable']) assert.ok(report.includes(field + '='));
});

test('failed or skipped coordinator validation excludes observations and is visible', () => {
  for (const validation of [{ passed: false }, { passed: true, postflight: { skipped: true } }]) {
    const report = buildReport(manifest, [run('native-empty', 10), run('wasm-empty', 15, 1, {}, { validation })]);
    const finding = section(report, 'Findings').split('\n').find(line => line.startsWith('| Sandbox path versus native handler |'));
    assert.match(finding, /unanswered/i);
    assert.doesNotMatch(charts(report).join('\n'), /wasm-empty/);
    assert.match(section(report, 'Handler and correctness validation'), /validation\./);
  }
});

const computeWorkload = { operation: 'action', table: 'SmallRows', rows: 10, iterations: 100, callbacks: 1,
  access: 'service', hook: false, pageSize: 1000, scanRows: 10000, enrichment: 'batch', mixed: false,
  readTable: 'SmallRows', queryShape: 'page', offset: 0, hookControl: false };

function ioTuple(io, values, repetition = 1) {
  const modes = ['native-compute', 'wasm-compute', `native-compute-${io}`, `wasm-compute-${io}`];
  return modes.map((mode, i) => run(mode, values[i], repetition, scenario({ mode, ...computeWorkload, expectedCallbacks: i < 2 ? 0 : 1 }),
    { validation: { passed: true, callbackBytes: i < 2 ? 0 : 120 } }));
}

test('query shape, offset and hook controls must match in ordinary comparisons', () => {
  for (const variant of [{ queryShape: 'key' }, { offset: 10 }, { hookControl: true }]) {
    const report = buildReport(manifest, [run('native-compute', 10, 1, computeWorkload),
      run('wasm-compute', 30, 1, { ...computeWorkload, ...variant })]);
    const finding = section(report, 'Findings').split('\n').find(line => line.startsWith('| Execution-location penalty for CPU work |'));
    assert.match(finding, /unanswered/i);
  }
});

test('callback read and write attribution uses matched repetition differences of differences', () => {
  for (const io of ['read', 'write']) {
    const report = buildReport(manifest, [...ioTuple(io, [10, 20, 15, 30]), ...ioTuple(io, [20, 40, 30, 60], 2)]);
    const attribution = section(report, 'Callback attribution');
    const finding = attribution.split('\n').find(line => line.startsWith(`| Auxiliary ${io} |`));
    assert.match(finding, /\| 2 \| 7\.5 \| 100 \| 3\.536 \|/);
    assert.match(attribution, /percentage of native incremental IO/i);
    assert.match(attribution, /empirical path comparison/i);
    assert.doesNotMatch(attribution, /isolates.*(?:callback|CPU)/i);
  }
});

test('callback attribution requires four eligible matching modes in the same repetition', () => {
  const tuple = ioTuple('read', [10, 20, 15, 30]);
  const variants = [tuple.slice(1), tuple.map((r, i) => i === 3 ? { ...r, repetition: 2 } : r),
    tuple.map((r, i) => i === 3 ? { ...r, validation: { passed: false } } : r),
    tuple.map((r, i) => i === 3 ? { ...r, scenario: { ...r.scenario, queryShape: 'other' } } : r),
    [...tuple, tuple[3]]];
  for (const results of variants) {
    const row = section(buildReport(manifest, results), 'Callback attribution').split('\n').find(line => line.startsWith('| Auxiliary read |'));
    assert.match(row, /unanswered/i);
  }
});

test('callback attribution preserves every declared workload dimension', () => {
  const tuple = ioTuple('read', [10, 20, 15, 30]);
  const variants = { operation: 'read', table: 'LargeRows', rows: 100, iterations: 101, callbacks: 2, access: 'db',
    hook: true, pageSize: 500, scanRows: 50000, enrichment: 'per-row', mixed: true, readTable: 'LargeRows',
    queryShape: 'key', offset: 10, hookControl: true };
  for (const [field, value] of Object.entries(variants)) {
    const results = tuple.map((result, i) => i === 3 ? { ...result, scenario: { ...result.scenario, [field]: value } } : result);
    const row = section(buildReport(manifest, results), 'Callback attribution').split('\n').find(line => line.startsWith('| Auxiliary read |'));
    assert.match(row, /unanswered/i, `mismatched ${field} must not support attribution`);
  }
});

test('manifest, per-run validation and partial errors exclude callback evidence', () => {
  for (const bad of [
    { validation: { passed: false } }, { probe: { handlerExecuted: false } }, { phase: 'limit' },
    { expectedFailure: 'time-limit' }, { stats: { successes: 19, errors: 1, meanMs: 30 } },
  ]) {
    const tuple = ioTuple('read', [10, 20, 15, 30]);
    tuple[3] = { ...tuple[3], ...bad };
    const report = buildReport(manifest, tuple);
    const row = section(report, 'Callback attribution').split('\n').find(line => line.startsWith('| Auxiliary read |'));
    assert.match(row, /unanswered/i);
  }
  const report = buildReport({ ...manifest, validation: { passed: false } }, ioTuple('read', [10, 20, 15, 30]));
  assert.match(section(report, 'Callback attribution'), /Auxiliary read.*Unanswered/);
  assert.doesNotMatch(section(report, 'Interpretation of benchmark findings'), /5 ms.*100%/);
});

test('zero native incremental IO leaves the attribution percentage unavailable', () => {
  const row = section(buildReport(manifest, ioTuple('write', [10, 20, 10, 25])), 'Callback attribution')
    .split('\n').find(line => line.startsWith('| Auxiliary write |'));
  assert.match(row, /\| 1 \| 5 \| unavailable \| unavailable \|/);
});

test('hook routing compares only idle hook controls with otherwise identical workloads', () => {
  const direct = run('oyster-idle', 10, 1, { ...computeWorkload, hookControl: true });
  const hooked = run('oyster-idle', 12, 1, { ...computeWorkload, hook: true, hookControl: true });
  const row = report => section(report, 'Findings').split('\n').find(line => line.startsWith('| Unimplemented hook routing |'));
  assert.match(row(buildReport(manifest, [direct, hooked])), /\| 1 \| 2 \| 20 \| unavailable \|/);
  for (const variant of [{ hookControl: false }, { queryShape: 'key' }, { iterations: 0 }, { offset: 1 }])
    assert.match(row(buildReport(manifest, [direct, { ...hooked, scenario: { ...hooked.scenario, ...variant } }])), /unanswered/i);
  assert.match(row(buildReport(manifest, [direct, { ...hooked, validation: { passed: false } }])), /unanswered/i);
  assert.match(row(buildReport(manifest, [run('native-empty', 10, 1, { ...computeWorkload, hookControl: true }), hooked])), /unanswered/i);
});

test('CPU iterations and scan rows scaling preserve the other workload dimensions', () => {
  const results = [run('wasm-compute', 5, 1, computeWorkload), run('wasm-compute', 10, 1, { ...computeWorkload, iterations: 1000 }),
    run('wasm-compute', 20, 1, scenario({ ...computeWorkload, mode: 'wasm-compute', operation: 'scan', scanRows: 10000 })),
    run('wasm-compute', 40, 1, scenario({ ...computeWorkload, mode: 'wasm-compute', operation: 'scan', scanRows: 50000 }))];
  const report = buildReport(manifest, results);
  assert.match(section(report, 'Measured charts'), /CPU iterations scaling/);
  assert.match(section(report, 'Measured charts'), /Scan row scaling/);
  const unmatched = buildReport(manifest, [results[2], { ...results[3], scenario: { ...results[3].scenario, pageSize: 500 } }]);
  assert.doesNotMatch(section(unmatched, 'Measured charts'), /Scan row scaling/);
});

test('question answers use recorded evidence and leave missing load and scaling evidence unanswered', () => {
  const report = buildReport({ ...manifest, settings: { ...manifest.settings, suite: 'smoke' } }, ioTuple('read', [10, 20, 15, 30]));
  const answers = section(report, 'Interpretation of benchmark findings');
  assert.match(answers, /CAP custom logic/);
  assert.match(answers, /Execution in Oyster/);
  assert.match(answers, /Net Oyster overhead/);
  assert.match(answers, /Callbacks versus native CQL/);
  assert.match(answers, /Large-result loops.*Unanswered/);
  assert.match(answers, /Heavy-load behavior.*Unanswered/);
  assert.match(answers, /5 ms.*100%/);
  assert.match(answers, /smoke.*stable overhead.*capacity/i);
});

test('load answers cite actual sweep values and distinguish missing generator evidence', () => {
  const results = [10, 20].map((load, i) => run('wasm-compute', 10 + i, 1, scenario({ ...computeWorkload, mode: 'wasm-compute' }),
    { load: { kind: 'arrival', value: load }, probe: { p95Ms: 2 + i }, resources: { clientCpuPercent: 50 } }));
  const answers = section(buildReport(manifest, results), 'Interpretation of benchmark findings');
  assert.match(answers, /load 10 to 20/);
  assert.match(answers, /Mean run p95 latency.*20 to 22/);
  assert.match(answers, /Client CPU is recorded/);
  assert.match(answers, /CPU isolation is unverified/);
  delete results[1].resources.clientCpuPercent;
  assert.match(section(buildReport(manifest, results), 'Interpretation of benchmark findings'), /Generator saturation is unverified/);
});

test('expected callback counts and callback byte validation appear in display and CSV without changing matching', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oyster-report-callback-'));
  try {
    const results = ioTuple('read', [10, 20, 15, 30]);
    await writeReport(dir, manifest, results);
    const report = await readFile(join(dir, 'details.md'), 'utf8');
    assert.match(section(report, 'Per-run latency and throughput'), /Expected callbacks/);
    assert.match(section(report, 'Handler and correctness validation'), /validation\.callbackBytes.*120/);
    const csv = await readFile(join(dir, 'results.csv'), 'utf8');
    assert.ok(csv.includes('scenario.expectedCallbacks'));
    assert.ok(csv.includes('validation.callbackBytes'));
    assert.match(section(report, 'Callback attribution'), /\| 1 \| 5 \| 100 \| unavailable \|/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
