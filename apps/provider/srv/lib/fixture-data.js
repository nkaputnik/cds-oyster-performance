const cds = require('@sap/cds');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const { createInterface } = require('node:readline');
const { resolve } = require('node:path');

const TABLES = Object.freeze(['SmallRows', 'LargeRows', 'WriteRows', 'LookupRows', 'SideEffectRows']);
const TECHNICAL = Object.freeze(['ID', 'groupNo', 'value', 'text']);
const PAGE_ROWS = 5000;
const columns = name => [...TECHNICAL, ...(name === 'WriteRows' ? ['lookupID', 'effectID', 'quantity', 'unitPrice'] : name === 'LookupRows' ? ['limit'] : [])];
function table(name) {
  if (!TABLES.includes(name)) throw Object.assign(new Error('Unknown fixture table'), { statusCode: 400 });
  return 'perf.' + name;
}
function normalized(name, row) {
  return Object.fromEntries(columns(name).map(column => {
    let value = row[column] === undefined ? (column === 'quantity' || column === 'unitPrice' ? 1 : column === 'limit' ? 1000 : null) : row[column];
    if (value !== null) {
      if (column === 'text') value = String(value);
      else {
        value = Number(value);
        if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) throw new Error('Invalid fixture integer column ' + column);
      }
    }
    return [column, value];
  }));
}
function canonical(name, row) {
  const value = normalized(name, row);
  return JSON.stringify(columns(name).map(column => value[column])) + '\n';
}
function accumulator(name) {
  const hash = createHash('sha256');
  const result = { count: 0, uniqueKeys: 0, minID: null, maxID: null, minValue: null, maxValue: null,
    minTextBytes: null, maxTextBytes: null, sample: [], ids: [] };
  let previous = -2147483649;
  return {
    add(row) {
      row = normalized(name, row);
      if (!Number.isInteger(row.ID) || row.ID <= previous) throw new Error('Fixture keys must be unique and ordered in ' + name);
      previous = row.ID; result.count++; result.uniqueKeys++;
      for (const [value, min, max] of [[row.ID, 'minID', 'maxID'], [row.value, 'minValue', 'maxValue'],
        [row.text === null ? null : Buffer.byteLength(row.text), 'minTextBytes', 'maxTextBytes']]) {
        if (value === null) continue;
        result[min] = result[min] === null ? value : Math.min(result[min], value);
        result[max] = result[max] === null ? value : Math.max(result[max], value);
      }
      if (result.sample.length < 1000) { result.sample.push(Object.fromEntries(TECHNICAL.map(column => [column, row[column]]))); result.ids.push(row.ID); }
      hash.update(canonical(name, row));
    },
    finish: () => ({ ...result, canonicalHash: hash.digest('hex'), columns: columns(name) }),
  };
}

async function* databaseRows(db, name, { count = Infinity, cursor, selected = columns(name) } = {}) {
  let left = count;
  while (left > 0) {
    const query = cds.ql.SELECT.from(table(name)).columns(...selected).orderBy('ID').limit(Math.min(PAGE_ROWS, left));
    if (cursor !== undefined) query.where('ID >', cursor);
    const rows = await db.run(query);
    if (!rows.length) break;
    for (const row of rows) yield row;
    left -= rows.length; cursor = rows.at(-1).ID;
  }
}

// CDS handles delimiters, numeric/null coercion and quoted fields. Record framing bounds memory.
async function* csvBatches(path, name) {
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header, records = [], record = '', quoted = false;
  const parse = () => {
    const [names, ...rows] = cds.parse.csv(header + '\n' + records.join('\n') + '\n');
    if (!names?.includes('ID') || names.some(column => !columns(name).includes(column))) throw new Error('Unexpected fixture CSV columns');
    return rows.map(values => normalized(name, Object.fromEntries(names.map((column, i) => [column, values[i]]))));
  };
  try {
    for await (const line of lines) {
      if (!header) { if (!line.trim() || line.startsWith('#')) continue; header = line; continue; }
      record += (record ? '\n' : '') + line;
      if (Buffer.byteLength(record) > 65536) throw new Error('Fixture CSV record exceeds byte bound');
      for (let i = 0; i < line.length; i++) if (line[i] === '"') {
        if (quoted && line[i + 1] === '"') i++; else quoted = !quoted;
      }
      if (quoted) continue;
      if (record.trim()) records.push(record);
      record = '';
      if (records.length >= PAGE_ROWS) { yield parse(); records = []; }
    }
    if (quoted) throw new Error('Unterminated fixture CSV field');
    if (!header) throw new Error('Missing fixture CSV header');
    if (records.length) yield parse();
  } finally { lines.close(); input.destroy(); }
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
const sourcePath = (dataRoot, name) => resolve(dataRoot, 'perf-' + name + '.csv');
async function sourceIdentities(dataRoot) {
  const sources = {};
  for (const name of TABLES) {
    const path = sourcePath(dataRoot, name), summary = accumulator(name);
    for await (const batch of csvBatches(path, name)) for (const row of batch) summary.add(row);
    sources[name] = { ...summary.finish(), csvSha256: await fileHash(path) };
    if (!sources[name].count) throw new Error('Empty fixture CSV for ' + name);
  }
  return sources;
}
async function inspectDatabase(db, sources) {
  const tables = {};
  for (const name of TABLES) {
    const summary = accumulator(name);
    for await (const row of databaseRows(db, name)) summary.add(row);
    tables[name] = summary.finish();
  }
  return { tables, sources, hashes: Object.fromEntries(TABLES.map(name => ['apps/provider/db/data/perf-' + name + '.csv', sources[name].csvSha256])),
    valid: TABLES.every(name => tables[name].canonicalHash === sources[name].canonicalHash && tables[name].count === sources[name].count),
    source: 'Authenticated tenant database compared with retained provider CSV files' };
}
async function inspectFixture(db, dataRoot) { return inspectDatabase(db, await sourceIdentities(dataRoot)); }
async function writeStateHash(db) {
  const hash = createHash('sha256');
  for await (const row of databaseRows(db, 'WriteRows')) hash.update(canonical('WriteRows', row));
  return hash.digest('hex');
}
module.exports = { TABLES, PAGE_ROWS, columns, table, normalized, canonical, databaseRows, csvBatches,
  sourcePath, sourceIdentities, inspectDatabase, inspectFixture, writeStateHash };
