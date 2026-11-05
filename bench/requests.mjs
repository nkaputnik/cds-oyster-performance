const MAX_INTEGER = 2147483647;
const CREATE_PARTITION = 10000000;

function keyFor(fixture, table, vu, exclusive = false) {
  const ids = fixture.tables[table]?.ids;
  if (!ids?.length) throw new Error('Missing generated fixture keys for ' + table);
  if (exclusive && vu > ids.length) throw new Error('Insufficient fixture keys for the VU partition in ' + table);
  return ids[(vu - 1) % ids.length];
}

export function readSpec(scenario, fixture, { vu = 1 } = {}) {
  const shape = scenario.queryShape || 'page';
  const spec = { shape, one: shape === 'key', rows: shape === 'key' ? 1 : scenario.rows, offset: shape === 'offset' ? scenario.offset || 0 : 0 };
  const table = fixture.tables[scenario.table];
  if (shape === 'key') spec.ID = keyFor(fixture, scenario.table, vu);
  if (shape === 'range') {
    if (!table?.ids?.length) throw new Error('Missing generated fixture keys for ' + scenario.table);
    const width = Math.min(spec.rows, table.ids.length), start = (vu - 1) % (table.ids.length - width + 1);
    spec.startID = table.ids[start]; spec.endID = table.ids[start + width - 1];
  }
  if (shape === 'non-indexed') {
    if (!table?.sample?.length) throw new Error('Missing generated fixture groupNo sample for ' + scenario.table);
    spec.groupNo = table.sample[(vu - 1) % table.sample.length].groupNo;
  }
  if (!['page', 'key', 'range', 'non-indexed', 'offset'].includes(shape)) throw new Error('Unknown queryShape: ' + shape);
  return spec;
}

export function requestFor(scenario, fixture, { vu = 1, iteration = 0 } = {}) {
  if (!Number.isSafeInteger(vu) || vu < 1) throw new Error('Invalid vu');
  if (!Number.isSafeInteger(iteration) || iteration < 0 || iteration >= CREATE_PARTITION)
    throw new Error('Invalid iteration: allocation supports fewer than 10000000 iterations per VU');
  const root = '/benchmark';
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const request = (method, path, body, expectedStatus = 200) => ({ method, path: root + path, body, headers, expectedStatus });
  const auxiliaryKeys = () => ({ lookupID: keyFor(fixture, 'LookupRows', vu),
    effectID: keyFor(fixture, 'SideEffectRows', vu, scenario.mode.endsWith('write')) });
  if (scenario.operation === 'create') {
    const base = Math.max(0, fixture.tables.WriteRows.maxID) + 1000000;
    const ID = base + vu * CREATE_PARTITION + iteration;
    if (!Number.isSafeInteger(ID) || ID > MAX_INTEGER) throw new Error('Create key exceeds CDS Integer 32-bit range');
    return request('POST', '/WriteRows', { ID, groupNo: 7, value: 7, text: 'benchmark', ...auxiliaryKeys() }, 201);
  }
  if (scenario.operation === 'update')
    return request('PATCH', '/WriteRows(' + keyFor(fixture, 'WriteRows', vu, true) + ')', { value: 7, ...auxiliaryKeys() });
  if (scenario.operation === 'read') {
    const spec = readSpec(scenario, fixture, { vu });
    const select = '$select=ID,groupNo,value,text,checksum';
    if (spec.one) return request('GET', '/' + scenario.table + '(' + spec.ID + ')?' + select);
    let query = select + '&$orderby=ID&$top=' + spec.rows;
    if (spec.shape === 'range') query += '&$filter=' + encodeURIComponent('ID ge ' + spec.startID + ' and ID le ' + spec.endID);
    if (spec.shape === 'non-indexed') query += '&$filter=' + encodeURIComponent('groupNo eq ' + spec.groupNo);
    if (spec.shape === 'offset') query += '&$skip=' + spec.offset;
    return request('GET', '/' + scenario.table + '?' + query);
  }
  if (scenario.operation === 'scan')
    return request('POST', '/scan', { cursor: fixture.tables.LargeRows.minID - 1, count: scenario.scanRows, pageSize: scenario.pageSize });
  if (scenario.operation === 'action') {
    if (!scenario.hook && !scenario.mode.includes('compute') && scenario.actionContract !== 'compute') return request('POST', '/noop', {}, 204);
    return request('POST', '/compute', { seed: 7, iterations: scenario.iterations, calls: scenario.callbacks,
      ...auxiliaryKeys() });
  }
  throw new Error('Unknown operation: ' + scenario.operation);
}
