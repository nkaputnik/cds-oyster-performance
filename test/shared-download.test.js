const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { mkdtemp, mkdir, readFile, rm, access } = require('node:fs/promises');
const { homedir } = require('node:os');
const { resolve, basename } = require('node:path');
const { createSharedClient } = require('../bench/cloud/shared.js');
const { loadResults } = require('../bench/overview-input.js');
test('failed shared download removes only its new folder and can be retried with portable report links', async t => {
  const parent = resolve(homedir(), 'git/clean-room/cds-oyster-performance-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'shared-download-'));
  const source = resolve(__dirname, '../examples/btp-short-2026-11-07');
  const manifest = JSON.parse(await readFile(resolve(source, 'manifest.json')));
  const content = {
    'manifest.json': JSON.stringify(manifest), 'results.json': JSON.stringify(await loadResults(source)),
    'results.csv': await readFile(resolve(source, 'results.csv'), 'utf8'), 'report.md': 'Old archived report', 'details.md': 'Old archived details',
  };
  const files = Object.entries(content).map(([name, text]) => ({ name, sha256: createHash('sha256').update(text).digest('hex') }));
  let fail = true;
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/files')) return Response.json({ files });
    const name = basename(url);
    if (name === 'results.csv' && fail) return Response.json({ error: 'Runner busy' }, { status: 409 });
    return new Response(content[name]);
  });
  const client = createSharedClient({ password: 'test-only' });
  const destination = resolve(root, manifest.id);
  try {
    await assert.rejects(client.download(manifest.runID, root), /Runner busy/);
    await assert.rejects(access(destination), { code: 'ENOENT' });
    fail = false;
    assert.equal(await client.download(manifest.runID, root), destination);
    assert.equal(await readFile(resolve(destination, 'manifest.json'), 'utf8'), content['manifest.json']);
    const report = await readFile(resolve(destination, 'report.md'), 'utf8');
    assert.match(report, /CDS-Oyster performance results/);
    assert.ok(report.includes('apps/extension/srv/'));
    assert.ok(!report.includes('sources/apps/extension/srv/'));
    await assert.rejects(client.download(manifest.runID, root), { code: 'EEXIST' });
    assert.equal(await readFile(resolve(destination, 'manifest.json'), 'utf8'), content['manifest.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
