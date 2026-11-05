import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { measureHTTP } from '../bench/load.mjs';
import { scenario } from '../bench/scenarios.mjs';

const fixture = { tables: { LookupRows: { ids: [1] }, SideEffectRows: { ids: [2] } } };
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
