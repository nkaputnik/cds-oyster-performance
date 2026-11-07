const test = require('node:test');
const assert = require('node:assert/strict');
const { buildReport, buildDetailedReport } = require('../bench/report.js');
const { scenario } = require('../bench/scenarios.js');
test('cloud reports identify HANA container scope and saved sources without local hardware or installation comparisons', () => {
  const manifest = { id: 'cloud-test', settings: { suite: 'short', repetitions: 1 }, environment: { execution: 'cloud', database: 'HANA', foundation: 'cf.example', region: 'eu12', dependencies: {} } };
  const results = ['native-empty', 'wasm-empty'].map(mode => ({ scenario: scenario({ mode }), repetition: 1, phase: 'warm', transport: 'http', load: { kind: 'vus', value: 1 }, stats: { successes: 100, errors: 0, meanMs: mode.startsWith('wasm') ? 2 : 1, p95Ms: 3 }, validation: { passed: true }, generatorResources: { cpuPercent: 5, rssPeakMiB: 20, eventLoopP99Ms: 2 } }));
  const report = buildReport(manifest, results), details = buildDetailedReport(manifest, results);
  assert.match(report, /HANA/); assert.match(report, /container-to-container/); assert.match(report, /cf.example/);
  assert.doesNotMatch(report, /SQLite|one machine|one host|Hardware \/ OS|plain CAP control|Paired runs/);
  assert.doesNotMatch(details, /Installed plugin overhead|SQLite/);
  assert.match(report, /sources\/extensions\/benchmark\/srv/);
  assert.match(details, /Generator CPU/);
  const pilot = buildReport({ ...manifest, settings: { ...manifest.settings, pilot: true } }, results);
  assert.match(pilot, /rate-limited.*pilot/i); assert.match(pilot, /3 workload requests\/s/);
  assert.doesNotMatch(pilot, /these are closed-loop concurrency measurements/);
});
test('routed cloud reports name HTTPS, TLS and CF router traversal for both full runs and pilots', () => {
  const manifest = { id: 'routed-test', settings: { suite: 'short', repetitions: 1 }, environment: { execution: 'cloud', database: 'HANA', network: { mode: 'cf-router', protocol: 'https:', tls: true, path: 'CF router' } } };
  for (const pilot of [false, true]) {
    const selected = { ...manifest, settings: { ...manifest.settings, pilot } };
    for (const report of [buildReport(selected, []), buildDetailedReport(selected, [])]) {
      assert.match(report, /CF router/); assert.match(report, /HTTPS/); assert.match(report, /TLS/);
      assert.match(report, /include.*TLS.*router costs/i);
      assert.doesNotMatch(report, /container-to-container/);
    }
  }
});
