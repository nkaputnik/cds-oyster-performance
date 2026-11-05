import { cpu } from '../lib/workload.mjs';

export function sandboxFiles(s, fixture) {
  if (!s.mode.startsWith('wasm-')) return {};
  if (s.mixed && !s.hook) return Object.assign({}, ...['create', 'update', 'read', 'action'].map(operation =>
    sandboxFiles({ ...s, mixed: false, operation, table: operation === 'read' ? (s.readTable || 'SmallRows') : 'WriteRows' }, fixture)));
  const constants = `const iterations = ${s.iterations}; const calls = ${s.callbacks};
    const lookupID = ${fixture.tables.LookupRows.ids[0]}; const effectID = ${fixture.tables.SideEffectRows.ids[0]};`;
  const calculate = (data, variable) => `
    let ${variable} = cpu(${data}.seed === undefined ? (${data}.value === undefined ? 7 : ${data}.value) : ${data}.seed, ${data}.iterations === undefined ? iterations : ${data}.iterations);
    for (let i = 0; i < (${data}.calls === undefined ? calls : ${data}.calls); i++) {
      ${s.mode.endsWith('-read') ? `const row = await SELECT.one.from(this.entities.LookupRows).columns('value').where({ ID: ${data}.lookupID === undefined ? lookupID : ${data}.lookupID }); ${variable} = (${variable} + row.value) & 2147483647;` : ''}
      ${s.mode.endsWith('-write') ? `await UPDATE.entity(this.entities.SideEffectRows).set({ value: ${variable} }).where({ ID: ${data}.effectID === undefined ? effectID : ${data}.effectID });` : ''}
    }`;
  const wrap = (body, after = false) => `module.exports = async function (${after ? 'result, ' : ''}req) {
    ${constants}
    ${cpu.toString()}
    ${body}
  };`;
  const empty = s.mode === 'wasm-empty';
  if (s.hook) return { 'BenchmarkExtensionService/on-evaluate.js': empty
    ? 'module.exports = async function(req) { return req.data.seed; };'
    : wrap(`${calculate('req.data', 'value')} return value;`) };
  const files = {};
  if (s.operation === 'create' || s.operation === 'update')
    files['BenchmarkService/WriteRows/before-' + (s.operation === 'create' ? 'CREATE' : 'UPDATE') + '.js'] = empty
      ? 'module.exports = async function(req) {};'
      : wrap(`${calculate('req.data', 'value')} req.data.value = value;`);
  if (s.operation === 'read') {
    const body = s.enrichment === 'per-row'
      ? `for (const row of result) { ${calculate('row', 'value')} row.checksum = value; }`
      : `const data = { seed: 0, iterations: 0 };
        ${s.mode.endsWith('-read') || s.mode.endsWith('-write') ? calculate('data', 'extra') : 'const extra = 0;'}
        for (const row of result) row.checksum = (cpu(row.value, iterations) + extra) & 2147483647;`;
    files['BenchmarkService/' + s.table + '/after-READ.js'] = empty
      ? 'module.exports = async function(result, req) {};' : wrap(body, true);
  }
  if (s.operation === 'action') {
    files['BenchmarkService/on-compute.js'] = empty
      ? 'module.exports = async function(req) { return req.data.seed; };'
      : wrap(`${calculate('req.data', 'value')} return value;`);
    files['BenchmarkService/on-noop.js'] = 'module.exports = async function(req) {};';
  }
  if (s.operation === 'scan') files['BenchmarkService/on-scan.js'] = wrap(`
    let cursor = req.data.cursor || 0; let left = req.data.count; let checksum = 0;
    while (left > 0) {
      const rows = await SELECT.from(this.entities.LargeRows).columns('ID', 'value')
        .where\`ID > \${cursor}\`.orderBy('ID').limit(Math.min(req.data.pageSize, left));
      if (!rows.length) req.reject(400, 'Scan requested more rows than exist');
      for (const row of rows) checksum = (checksum + cpu(row.value, iterations)) & 2147483647;
      left -= rows.length; cursor = rows[rows.length - 1].ID;
    }
    return checksum;`);
  return files;
}
