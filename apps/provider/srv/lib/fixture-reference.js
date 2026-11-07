const cds = require('@sap/cds');
const { table, databaseRows } = require('./fixture-data.js');

function integer(req, value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) req.reject(400, 'Invalid bounded ' + label);
  return value;
}
function specification(req) {
  const text = req.data.specification;
  if (typeof text !== 'string' || Buffer.byteLength(text) > 4096) req.reject(400, 'Bounded reference specification required');
  let result; try { result = JSON.parse(text); } catch { req.reject(400, 'Invalid reference JSON'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) req.reject(400, 'Reference object required');
  return result;
}
async function readReference(req) {
  const spec = specification(req), shape = spec.shape || 'page';
  if (!['SmallRows', 'LargeRows', 'WriteRows'].includes(spec.table)) req.reject(400, 'Unknown reference READ table');
  if (!['page', 'key', 'range', 'non-indexed', 'offset'].includes(shape)) req.reject(400, 'Unknown reference READ shape');
  const rows = integer(req, spec.rows, 1, 10000, 'row limit');
  const offset = integer(req, spec.offset ?? 0, 0, 1000000, 'offset');
  const query = cds.ql.SELECT.from(table(spec.table)).columns('ID', 'groupNo', 'value', 'text').orderBy('ID').limit(rows, offset);
  if (shape === 'key') query.where({ ID: integer(req, spec.ID, -2147483648, 2147483647, 'key') });
  if (shape === 'range') {
    const start = integer(req, spec.startID, -2147483648, 2147483647, 'range start');
    const end = integer(req, spec.endID, start, 2147483647, 'range end');
    query.where('ID >=', start, 'and ID <=', end);
  }
  if (shape === 'non-indexed') query.where({ groupNo: integer(req, spec.groupNo, -2147483648, 2147483647, 'group filter') });
  return cds.db.tx(req).run(query);
}
async function scanReference(req) {
  const spec = specification(req);
  const count = integer(req, spec.scanRows, 1, 1000000, 'scan count');
  const iterations = integer(req, spec.iterations ?? 100, 0, 1000, 'scan iterations');
  let checksum = 0, seen = 0;
  for await (const row of databaseRows(cds.db.tx(req), 'LargeRows', { count, selected: ['ID', 'value'] })) {
    let value = row.value & 2147483647;
    for (let i = 0; i < iterations; i++) value = (value * 17 + i * 2 - 1) & 2147483647;
    checksum = (checksum + value) & 2147483647; seen++;
  }
  if (seen !== count) req.reject(400, 'Reference scan requested more rows than exist');
  return checksum;
}
module.exports = { integer, readReference, scanReference };
