const test = require('node:test');
const assert = require('node:assert/strict');
const { scryptSync } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { createSharedRunner } = require('../apps/runner/shared.js');
const config = { username: 'guest', salt: 'a'.repeat(32), publicOrigin: 'https://runner.example', hash: scryptSync('test-password', 'a'.repeat(32), 32).toString('hex') };
const authorization = 'Basic ' + Buffer.from('guest:test-password').toString('base64');
async function request(handler, method, url, headers = {}, data) {
  const req = new EventEmitter(); Object.assign(req, { method, url, headers });
  let status, body, responseHeaders;
  const res = { writeHead: (code, values) => { status = code; responseHeaders = values; }, end: value => { body = value; } };
  const pending = handler(req, res);
  if (data !== undefined) { await new Promise(resolve => setImmediate(resolve)); req.emit('data', Buffer.from(data)); req.emit('end'); }
  await pending;
  return { status, headers: responseHeaders, body: body && JSON.parse(body) };
}
test('shared runner authenticates, protects start from browser CSRF and accepts one fixed preset', async () => {
  let child, args;
  const handler = createSharedRunner({ config, launch: values => { args = values; child = new EventEmitter(); return child; } });
  assert.equal((await request(handler, 'GET', '/status')).status, 401);
  const status = await request(handler, 'GET', '/status', { authorization, 'x-csrf-token': 'Fetch' });
  assert.equal(status.status, 200);
  const headers = { authorization, 'content-type': 'application/json', 'x-csrf-token': status.headers['x-csrf-token'] };
  assert.equal((await request(handler, 'POST', '/runs', { ...headers, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(handler, 'POST', '/runs', { ...headers, 'x-csrf-token': 'wrong' })).status, 403);
  assert.equal((await request(handler, 'POST', '/runs', { ...headers, 'x-csrf-token': 'ø'.repeat(64) })).status, 403);
  assert.equal((await request(handler, 'POST', '/runs', headers, JSON.stringify({ suite: 'short', tenant: 'other' }))).status, 400);
  assert.equal((await request(handler, 'POST', '/runs', headers, JSON.stringify({ suite: 'short' }))).status, 202);
  assert.deepEqual(args, ['--suite', 'short']);
  assert.equal((await request(handler, 'POST', '/runs', headers, JSON.stringify({ suite: 'long' }))).status, 409);
  child.emit('message', { type: 'progress', runID: 'abc', completed: 5 });
  assert.equal((await request(handler, 'GET', '/status', { authorization })).body.active.completed, 5);
  child.emit('exit', 0);
  assert.equal((await request(handler, 'GET', '/status', { authorization })).body.active, null);
  assert.equal((await request(handler, 'GET', '/env', { authorization })).status, 404);
});
test('shared runner requires configured verifier and HTTPS public origin', () => {
  assert.throws(() => createSharedRunner({ config: {} }), /login/);
  assert.throws(() => createSharedRunner({ config: { ...config, publicOrigin: 'http://runner.example' } }), /HTTPS/);
});
test('HTTP trigger admits only one concurrent run and does not allow report traffic during measurement', async () => {
  const server = require('node:http').createServer(createSharedRunner({ config, launch: () => new EventEmitter(), listRuns: () => { throw new Error('must not query measured provider'); } }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  try {
    const status = await fetch(url + '/status', { headers: { authorization, 'x-csrf-token': 'Fetch' } });
    const token = status.headers.get('x-csrf-token'); await status.body.cancel();
    const values = await Promise.all([1, 2].map(() => fetch(url + '/runs', { method: 'POST', headers: { authorization, 'content-type': 'application/json', 'x-csrf-token': token }, body: JSON.stringify({ suite: 'short' }) })));
    assert.deepEqual(values.map(r => r.status).sort(), [202, 409]);
    await Promise.all(values.map(r => r.body.cancel()));
    const history = await fetch(url + '/runs', { headers: { authorization } }); assert.equal(history.status, 409); await history.body.cancel();
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('legacy final report uses the committed artifact IDs rather than arbitrary checkpoints', () => {
  const { reportFiles } = require('../apps/runner/shared-evidence.js');
  const files = ['manifest.json', 'results.json', 'results.csv', 'report.md', 'details.md'];
  const index = { format: 'oyster-cloud-report-v1', files: Object.fromEntries(files.map(name => [name, 'legacy embedded text'])), artifacts: files.map(name => ({ path: 'final-2/' + name, ID: name, originalSha256: 'a'.repeat(64) })) };
  const selected = reportFiles(index, { path: 'final-2/final-report.json' });
  assert.deepEqual(selected.map(file => file.ID), files);
  assert.throws(() => reportFiles(index, { path: 'final-1/final-report.json' }), /identity missing/);
  const current = { format: index.format, files: Object.fromEntries(files.map(name => [name, { ID: name, originalSha256: 'a'.repeat(64) }])) };
  assert.deepEqual(reportFiles(current, { path: 'final-1/final-report.json' }), selected);
});
test('login setup rejects passwords that the runner cannot authenticate', () => {
  const { loginCredentials } = require('../bench/cloud/login-service.js');
  for (const password of ['', 'x'.repeat(257)]) assert.throws(() => loginCredentials({ username: 'guest', publicOrigin: 'https://runner.example', password }), /Password/);
});
