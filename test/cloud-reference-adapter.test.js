const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { verifyScenario, publicRequest } = require('../bench/verify.js');
const { scenario } = require('../bench/scenarios.js');

const rows = [{ ID: 11, groupNo: 7, value: 2, text: 'a' }, { ID: 37, groupNo: 3, value: 8, text: 'b' }];
const table = { count: 2, minID: 11, maxID: 37, ids: [11, 37], sample: rows };
const fixture = { tables: Object.fromEntries(['SmallRows', 'LargeRows', 'WriteRows', 'LookupRows', 'SideEffectRows'].map(name => [name, table])) };

test('verifyScenario uses an injected cloud reference and cached auth for mixed public operations', async () => {
  const calls = [], written = new Map(rows.map(row => [row.ID, row]));
  const listener = http.createServer(async (req, res) => {
    calls.push({ path: req.url, auth: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer cached-token') { res.statusCode = 401; return res.end('{}'); }
    let text = ''; for await (const part of req) text += part;
    const body = text ? JSON.parse(text) : undefined;
    if (req.url.startsWith('/benchmark/NoHandlerSmallRows')) return res.end(JSON.stringify({ value: rows }));
    if (req.url === '/benchmark/noop') { res.statusCode = 204; return res.end(); }
    if (req.method === 'POST') { written.set(body.ID, body); res.statusCode = 201; return res.end(JSON.stringify(body)); }
    const ID = Number(req.url.match(/\((\d+)\)$/)?.[1]);
    if (req.method === 'PATCH') written.set(ID, { ...written.get(ID), ...body });
    res.end(JSON.stringify(written.get(ID)));
  });
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const server = { url: 'http://127.0.0.1:' + listener.address().port,
    state: { plugins: ['@sap/cds-oyster'], engine: 'oyster', annotations: [] }, headers: { authorization: 'Bearer cached-token' } };
  try {
    let reads = 0;
    const reference = { readReference: async (s, f, request) => { reads++; assert.equal(f, fixture); assert.ok(request.path); return rows; } };
    const result = await verifyScenario(server, scenario({ mode: 'oyster-idle', operation: 'read', rows: 2, mixed: true }), fixture,
      { reference, referenceDatabase: '/must-not-open-cloud-sqlite', rollback: false });
    assert.equal(result.passed, true); assert.equal(reads, 1); assert.equal(result.mixedOperations.length, 3);
    assert.ok(calls.length >= 6); assert.ok(calls.every(call => call.auth === 'Bearer cached-token'));
    assert.equal((await publicRequest({ url: server.url }, { method: 'POST', path: '/benchmark/noop' },
      { headers: { authorization: 'Bearer cached-token' } })).status, 204);
  } finally { await new Promise(done => listener.close(done)); }
});
test('verifyScenario obtains scan checksum from the cloud adapter without opening SQLite', async () => {
  const listener = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"value":12345}'); });
  await new Promise(done => listener.listen(0, '127.0.0.1', done));
  const server = { url: 'http://127.0.0.1:' + listener.address().port, state: { plugins: ['@sap/cds-oyster'], engine: 'oyster', annotations: [] } };
  try {
    let scans = 0;
    const result = await verifyScenario(server, scenario({ mode: 'native-compute', operation: 'scan', scanRows: 2 }), fixture,
      { reference: { scanReference: async s => { scans++; assert.equal(s.scanRows, 2); return 12345; } }, rollback: false, referenceDatabase: '/must-not-open-cloud-sqlite' });
    assert.equal(result.checksum, 12345); assert.equal(scans, 1);
  } finally { await new Promise(done => listener.close(done)); }
});
