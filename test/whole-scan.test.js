const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { referenceChunks } = require('../bench/whole-scan.js');
const { cpu } = require('../apps/provider/srv/lib/workload.js');

test('external scan chunks cover sparse keys exactly once and preserve whole checksum', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oyster-chunks-'));
  const path = join(root, 'fixture.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE perf_LargeRows (ID INTEGER PRIMARY KEY,value INTEGER)');
  const values = [[3, 7], [10, 1], [25, 5], [100, 9], [200, 2]];
  for (const [ID, value] of values) db.prepare('INSERT INTO perf_LargeRows VALUES (?,?)').run(ID, value);
  db.close();
  try {
    const chunks = referenceChunks(path, { rows: 5, chunkRows: 2, iterations: 3 });
    assert.deepEqual(chunks.map(c => [c.cursor, c.count, c.lastID]), [[2, 2, 10], [10, 2, 100], [100, 1, 200]]);
    const whole = values.reduce((sum, [, value]) => (sum + cpu(value, 3)) & 2147483647, 0);
    assert.equal(chunks.reduce((sum, c) => (sum + c.checksum) & 2147483647, 0), whole);
    assert.throws(() => referenceChunks(path, { rows: 6, chunkRows: 2 }), /requested rows/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
