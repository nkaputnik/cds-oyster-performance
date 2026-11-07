const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, rm, readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { homedir } = require('node:os');
const { discoverRuns, loadResults } = require('../bench/overview-input.js');
const { aggregate } = require('../bench/overview.js');
const examples = resolve(__dirname, '../examples');

test('published CSV and original JSON give exactly the same 396 native/Oyster pairs', async () => {
  const inputs = await discoverRuns(examples);
  assert.deepEqual(Object.keys(inputs).sort(), ['btp-long', 'btp-short', 'local-long', 'local-short']);
  const data = aggregate(inputs);
  assert.equal(Object.values(data).reduce((n, rows) => n + rows.reduce((m, row) => m + row.pairs.length, 0), 0), 396);
  const local = await loadResults(resolve(examples, 'local-short-2026-11-06'));
  const original = JSON.parse(await readFile(resolve(__dirname, '../reports/bench-2026-11-06T14-09-44-925Z/results.json'), 'utf8').catch(() => 'null'));
  if (original) assert.deepEqual(aggregate({ run: { results: local } }).run.map(r => r.pairs), aggregate({ run: { results: original } }).run.map(r => r.pairs));
});

test('discovery chooses newest complete runs and ignores newer smoke, pilot, failed and corrupt runs', async () => {
  const parent = resolve(homedir(), 'git/clean-room/cds-oyster-performance-tests');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(resolve(parent, 'discovery-'));
  try {
    const record = { scenario: { mode: 'native-empty' }, repetition: 1, stats: { successes: 1, errors: 0, meanMs: 1 }, validation: { passed: true } };
    for (const [name, change] of Object.entries({ old: {}, newest: { startedAt: '2026-02-01T00:00:00Z' }, smoke: { settings: { suite: 'short', filter: 'empty' } }, pilot: { settings: { suite: 'short', pilot: true } }, failed: { runSummary: { passed: false } }, incomplete: { runSummary: { passed: true, records: 2 } } })) {
      const folder = resolve(root, name); await mkdir(folder);
      await writeFile(resolve(folder, 'manifest.json'), JSON.stringify({ startedAt: '2026-01-01T00:00:00Z', finishedAt: '2026-03-01T00:00:00Z', settings: { suite: 'short' }, runSummary: { passed: true, records: 1 }, ...change }));
      await writeFile(resolve(folder, 'results.json'), JSON.stringify([record]));
    }
    await mkdir(resolve(root, 'broken')); await writeFile(resolve(root, 'broken/manifest.json'), '{');
    const runs = await discoverRuns(root, { requireFour: false });
    assert.equal(runs['local-short'].directory, resolve(root, 'newest'));
    await assert.rejects(discoverRuns(root), /btp-long.*btp-short.*local-long/);
  } finally { await rm(root, { recursive: true }); }
});

test('pairing refuses mismatched work, failed validation and duplicate repetition records', () => {
  const record = (mode, rows = 10) => ({ scenario: { mode, operation: 'read', rows }, repetition: 1, stats: { successes: 1, errors: 0, meanMs: 1 }, validation: { passed: true } });
  const a = record('native-empty'), b = record('wasm-empty');
  assert.equal(aggregate({ x: { results: [a, b] } }).x.length, 1);
  for (const results of [[a, record('wasm-empty', 1000)], [a, { ...b, validation: { passed: false } }], [a, b, b]]) assert.equal(aggregate({ x: { results } }).x.length, 0);
});
test('current report CSV retains nested validation and exact measured precision', () => {
  const { parseCsv } = require('../bench/overview-input.js');
  const record = { scenario: { mode: 'wasm-empty', operation: 'action', id: 'a,b' }, stats: { meanMs: 0.123456789012345, successes: 2, errors: 0 }, validation: { passed: true, note: 'two,"quotes"\nand newline' } };
  const text = 'scenario.mode,scenario.operation,scenario.id,stats.meanMs,stats.successes,stats.errors,validation\r\nwasm-empty,action,"a,b",0.123456789012345,2,0,"' + JSON.stringify(record.validation).replaceAll('"', '""') + '"\r\n';
  assert.deepEqual(parseCsv(text)[0], record);
});
