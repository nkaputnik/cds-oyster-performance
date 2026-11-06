const test = require('node:test');
const assert = require('node:assert/strict');
const { scenario, suite } = require('../bench/scenarios.js');
const { requestFor } = require('../bench/requests.js');
const { validateResponse } = require('../bench/verify.js');
const { buildReport } = require('../bench/report.js');

const fixture = { tables: { WriteRows: { maxID: 10, ids: [1, 2] }, LookupRows: { ids: [3] }, SideEffectRows: { ids: [4] } } };

test('presets measure both decisions for matched CRUD and predefined validation handlers without synthetic work', () => {
  for (const name of ['short', 'long']) {
    const cases = suite(name);
    for (const mode of ['native-validate', 'wasm-validate', 'native-validate-read', 'wasm-validate-read']) {
      for (const validationOutcome of ['accepted', 'rejected']) {
        for (const operation of ['create', 'update', 'action']) {
          const s = cases.find(s => s.mode === mode && s.operation === operation && !s.hook && s.validationOutcome === validationOutcome);
          assert.ok(s, [name, mode, operation, validationOutcome].join(' '));
          assert.equal(s.iterations, 0);
          assert.equal(s.expectedFailure, null);
        }
        assert.ok(cases.some(s => s.mode === mode && s.hook && s.validationOutcome === validationOutcome));
      }
    }
    assert.ok(cases.filter(s => s.mode.includes('validate')).length > cases.filter(s => s.iterations > 0 && s.mode.includes('compute')).length);
    assert.ok(cases.filter(s => s.mode.includes('compute-')).every(s => s.iterations === 0));
    assert.equal(new Set(cases.map(s => s.id + JSON.stringify(s.benchmarkLoad))).size, cases.length);
  }
});

test('constraint requests separate rejection status and identity from sandbox limit failures', () => {
  for (const operation of ['create', 'update', 'action']) for (const hook of operation === 'action' ? [false, true] : [false]) {
    const accepted = scenario({ mode: 'wasm-validate-read', operation, hook, validationOutcome: 'accepted', iterations: 0 });
    const rejected = scenario({ ...accepted, validationOutcome: 'rejected' });
    const a = requestFor(accepted, fixture), b = requestFor(rejected, fixture);
    assert.notEqual(accepted.id, rejected.id);
    assert.match(a.path, /OysterValidationReadWriteRows|oysterValidationRead/);
    assert.equal(a.body.quantity * a.body.unitPrice, 20);
    assert.equal(b.body.quantity * b.body.unitPrice, 2000);
    assert.equal(b.expectedStatus, 400);
    assert.equal(rejected.expectedCallbacks, 1);
    assert.equal(rejected.expectedFailure, null);
    validateResponse(rejected, fixture, b, { status: 400, body: { error: { message: 'Amount exceeds limit' } } });
    assert.throws(() => validateResponse(rejected, fixture, b, { status: 400, body: { error: { message: 'Malformed request' } } }), /rejection/i);
  }
  assert.throws(() => scenario({ mode: 'wasm-validate', operation: 'read' }), /validation/i);
  assert.throws(() => scenario({ mode: 'wasm-validate', validationOutcome: 'unknown' }), /outcome/i);
});

test('ordinary constraint findings lead the report and accepted/rejected evidence never pairs', () => {
  const result = (mode, validationOutcome, meanMs) => ({ scenario: scenario({ mode, validationOutcome, operation: 'create', iterations: 0 }),
    repetition: 1, phase: 'warm', transport: 'http', load: { kind: 'vus', value: 1 },
    stats: { successes: 100, errors: 0, meanMs }, validation: { passed: true } });
  const manifest = { finishedAt: '2026-11-06', settings: { suite: 'short' }, validation: { passed: true } };
  const report = buildReport(manifest, [result('native-validate', 'accepted', 1), result('wasm-validate', 'accepted', 2),
    result('native-validate', 'rejected', 3), result('wasm-validate', 'rejected', 4)]);
  assert.match(report, /quantity.*unitPrice/);
  assert.match(report, /accepted/i);
  assert.match(report, /rejected/i);
  assert.ok(report.includes('OysterValidationWriteRows/before-CREATE.js'));
  assert.ok(report.indexOf('Business constraint') < report.indexOf('What is the typical overhead'));
  const mismatched = buildReport(manifest, [result('native-validate', 'accepted', 1), result('wasm-validate', 'rejected', 4)]);
  assert.ok(!mismatched.includes('bar [1, 4]') && !mismatched.includes('+3 ms'));
});
