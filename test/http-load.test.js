const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { measureHTTP } = require('../bench/load.js');
const { scenario } = require('../bench/scenarios.js');

const fixture = { tables: { LookupRows: { ids: [1] }, SideEffectRows: { ids: [2] } } };
test('cached authorization reaches workload and probe without entering evidence', async () => {
  const secret = 'Bearer confidential-test-token';
  let probes = 0;
  const { server, url } = await listen((req, res) => {
    if (req.url.endsWith('/probe')) probes++;
    res.writeHead(req.headers.authorization === secret ? (req.url.endsWith('/probe') ? 200 : 204) : 401); res.end();
  });
  try {
    const result = await measureHTTP({ url, headers: { authorization: secret }, collectResources: true,
      scenario: scenario({ mode: 'oyster-idle' }), fixture, load: { kind: 'vus', value: 2 }, seconds: 1, probeRate: 2 });
    assert.equal(result.stats.errors, 0); assert.equal(result.probe.errors, 0); assert.ok(probes > 0);
    assert.ok(result.generatorResources.rssPeakMiB > 0);
    assert.equal(JSON.stringify(result).includes(secret), false);
  } finally { await new Promise(done => server.close(done)); }
});
test('cancellation stops closed-loop load and produces partial resource evidence', async () => {
  const { server, url } = await listen((req, res) => { res.writeHead(204); res.end(); });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    const result = await measureHTTP({ url, signal: controller.signal, collectResources: true,
      scenario: scenario({ mode: 'oyster-idle' }), fixture, load: { kind: 'vus', value: 1 }, seconds: 10 });
    assert.equal(result.stats.cancelled, true); assert.ok(result.stats.elapsedSeconds < 3);
    assert.ok(result.generatorResources.rssPeakMiB > 0);
  } finally { clearTimeout(timer); await new Promise(done => server.close(done)); }
});
test('explicit pilot rate cap limits offered traffic and records its distinct protocol', async () => {
  const { server, url } = await listen((req, res) => { res.writeHead(204); res.end(); });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'oyster-idle' }), fixture, load: { kind: 'vus', value: 1 }, seconds: 2, overallRate: 3 });
    assert.ok(result.stats.successes <= 9); assert.ok(result.stats.successes >= 3);
    assert.equal(result.protocol, 'rate-limited-pilot'); assert.equal(result.stats.offeredRps, 3);
  } finally { await new Promise(done => server.close(done)); }
});
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}
test('HTTP samples exclude failures and preserve sub-millisecond precision', async () => {
  let requests = 0;
  const { server, url } = await listen((req, res) => { requests++; res.writeHead(requests % 3 === 0 ? 500 : 204); res.end(); });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'cap-baseline' }), fixture, load: { kind: 'vus', value: 2 }, seconds: 1 });
    assert.ok(result.stats.successes > 0);
    assert.ok(result.stats.errors > 0);
    assert.equal(result.rawDurationsMs.length, result.stats.successes);
    assert.ok(result.stats.meanMs > 0);
    assert.equal(result.stats.droppedIterations, null);
  } finally { await new Promise(done => server.close(done)); }
});
test('HTTP workload and lightweight probe are counted separately', async () => {
  const { server, url } = await listen((req, res) => { res.writeHead(req.url.endsWith('/probe') ? 200 : 204); res.end(); });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'cap-baseline' }), fixture, load: { kind: 'vus', value: 2 }, seconds: 1, probeRate: 2 });
    assert.ok(result.stats.successes > 0);
    assert.ok(result.probe.attempts > 0);
    assert.equal(result.probe.errors, 0);
    assert.equal(result.stats.errors, 0);
  } finally { await new Promise(done => server.close(done)); }
});

test('expected constraint rejections are measured and unrelated 400 errors are failures', async () => {
  let requests = 0;
  const { server, url } = await listen((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: ++requests % 3 ? 'Amount exceeds limit' : 'Malformed request' } }));
  });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'wasm-validate', validationOutcome: 'rejected' }), fixture, load: { kind: 'vus', value: 1 }, seconds: 1 });
    assert.ok(result.stats.expectedRejections > 0);
    assert.equal(result.stats.successes, result.stats.expectedRejections);
    assert.equal(result.stats.acceptedRequests, 0);
    assert.ok(result.stats.errors > 0);
    assert.equal(result.rawDurationsMs.length, result.stats.expectedRejections);
  } finally { await new Promise(done => server.close(done)); }
});

test('collection read succeeds when response contains the expected row count', async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ ID: i + 1 }));
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: rows }));
  });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'cap-baseline', operation: 'read' }), fixture, load: { kind: 'vus', value: 1 }, seconds: 1 });
    assert.ok(result.stats.successes > 0);
    assert.equal(result.stats.errors, 0);
  } finally { await new Promise(done => server.close(done)); }
});

test('collection read fails when response row count does not match expected', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ value: [{ ID: 1 }] }));
  });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'cap-baseline', operation: 'read' }), fixture, load: { kind: 'vus', value: 1 }, seconds: 1 });
    assert.equal(result.stats.successes, 0);
    assert.ok(result.stats.errors > 0);
    assert.equal(result.failures[0].expectedRows, 10);
    assert.equal(result.failures[0].actualRows, 1);
  } finally { await new Promise(done => server.close(done)); }
});

test('collection read fails on malformed JSON response', async () => {
  const { server, url } = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"value": [{');
  });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'cap-baseline', operation: 'read' }), fixture, load: { kind: 'vus', value: 1 }, seconds: 1 });
    assert.equal(result.stats.successes, 0);
    assert.ok(result.stats.errors > 0);
  } finally { await new Promise(done => server.close(done)); }
});

test('connection-close rejections keep per-request latency across reconnects', async () => {
  const { server, url } = await listen((req, res) => {
    req.resume();
    res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' });
    res.end(JSON.stringify({ error: { message: 'Amount exceeds limit' } }));
  });
  try {
    const result = await measureHTTP({ url, scenario: scenario({ mode: 'wasm-validate', validationOutcome: 'rejected' }), fixture, load: { kind: 'vus', value: 1 }, seconds: 1 });
    assert.equal(result.stats.errors, 0);
    assert.ok(result.stats.expectedRejections > 100);
    assert.ok(result.stats.p95Ms < 50, 'Immediate rejections must not accumulate elapsed benchmark time');
  } finally { await new Promise(done => server.close(done)); }
});
