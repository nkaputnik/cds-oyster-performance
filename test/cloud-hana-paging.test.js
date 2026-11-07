const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdir, mkdtemp, rm } = require('node:fs/promises');
const { resolve } = require('node:path');
const { homedir } = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const cds = require('@sap/cds');
const HANAService = require('@cap-js/hana');
const Writer = require('hdb/lib/protocol/Writer');
const { TypeCode } = require('hdb/lib/protocol/common');
const { databaseRows } = require('../apps/provider/srv/lib/fixture-data.js');

test('paged fixture queries bind legal HANA INT cursors and include minimum and maximum keys', async () => {
  const scratch = resolve(homedir(), 'git/clean-room/oyster-btp-implementation-20261106');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(resolve(scratch, 'hana-paging-'));
  const database = resolve(directory, 'fixture.sqlite');
  const model = cds.compile.for.nodejs(await cds.load(resolve(__dirname, '../apps/provider/db/schema.cds')));
  const expected = [...Array.from({ length: 10001 }, (_, i) => -2147483648 + i), 2147483647];
  const seed = new DatabaseSync(database);
  for (const ddl of cds.compile.to.sql(model, { dialect: 'sqlite' })) seed.exec(ddl);
  seed.exec('BEGIN');
  const insert = seed.prepare('INSERT INTO perf_SmallRows(ID,value) VALUES(?,?)');
  for (const ID of expected) insert.run(ID, 1);
  seed.exec('COMMIT'); seed.close();
  const sqlite = await cds.connect.to({ kind: 'sqlite', impl: require.resolve('@cap-js/sqlite'), credentials: { url: database }, model });
  const hana = new HANAService('hana-rendering-only', model, { kind: 'hana', credentials: {} });
  hana.server = { major: 4 };
  const rendered = [];
  try {
    const verifiedDatabase = { run(query) {
      const result = hana.cqn2sql(query); rendered.push(result);
      const writer = new Writer({ types: [TypeCode.INT], fractions: [0] });
      for (const value of result.values || []) writer[TypeCode.INT](value);
      return sqlite.run(query);
    } };
    const actual = [];
    for await (const row of databaseRows(verifiedDatabase, 'SmallRows')) actual.push(row.ID);
    assert.deepEqual(actual, expected);
    assert.ok(rendered.length >= 3);
    assert.equal(rendered[0].values?.length || 0, 0, 'The first page must not bind an artificial cursor');
    assert.ok(rendered.slice(1).every(page => page.values.length === 1 && expected.includes(page.values[0])));
  } finally { await sqlite.disconnect(); await rm(directory, { recursive: true, force: true }); }
});
