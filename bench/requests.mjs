const MAX_INTEGER = 2147483647;
const CREATE_PARTITION = 100000;

function keyFor(fixture, table, vu, exclusive = false, iteration = 0, clients = vu) {
  const ids = fixture.tables[table]?.ids;
  if (!ids?.length) throw new Error('Missing CSV keys for ' + table);
  const width = Math.floor(ids.length / clients);
  if (!width && exclusive) throw new Error('Insufficient CSV keys for client partitions in ' + table);
  if (!exclusive) return ids[(vu - 1 + iteration) % ids.length];
  return ids[(vu - 1) * width + iteration % width];
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

export function requestFor(scenario, fixture, { vu = 1, iteration = 0, clients = vu } = {}) {
  if (!Number.isSafeInteger(vu) || vu < 1) throw new Error('Invalid vu');
  if (!Number.isSafeInteger(iteration) || iteration < 0 || iteration >= CREATE_PARTITION)
    throw new Error('Invalid iteration: allocation supports fewer than 100000 iterations per VU');
  const root = '/benchmark';
  const route = endpoint(scenario);
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const request = (method, path, body, expectedStatus = 200) => ({ method, path: root + path, body, headers, expectedStatus });
  const auxiliaryKeys = () => ({ lookupID: keyFor(fixture, 'LookupRows', vu, false, iteration, clients),
    effectID: keyFor(fixture, 'SideEffectRows', vu, true, iteration, clients) });
  if (scenario.operation === 'create') {
    const base = Math.max(0, fixture.tables.WriteRows.maxID) + 1000000;
    const ID = base + (fixture.createOffset || 0) + vu * CREATE_PARTITION + iteration;
    if (!Number.isSafeInteger(ID) || ID > MAX_INTEGER) throw new Error('Create key exceeds CDS Integer 32-bit range');
    return request('POST', '/' + route.entity, { ID, groupNo: 7, value: 7, text: 'benchmark', ...auxiliaryKeys() }, 201);
  }
  if (scenario.operation === 'update')
    return request('PATCH', '/' + route.entity + '(' + keyFor(fixture, 'WriteRows', vu, true, iteration, clients) + ')', { value: 7, ...auxiliaryKeys() });
  if (scenario.operation === 'read') {
    const spec = readSpec(scenario, fixture, { vu });
    const select = '$select=ID,groupNo,value,text,checksum';
    if (spec.one) return request('GET', '/' + route.entity + '(' + spec.ID + ')?' + select);
    let query = select + '&$orderby=ID&$top=' + spec.rows;
    if (spec.shape === 'range') query += '&$filter=' + encodeURIComponent('ID ge ' + spec.startID + ' and ID le ' + spec.endID);
    if (spec.shape === 'non-indexed') query += '&$filter=' + encodeURIComponent('groupNo eq ' + spec.groupNo);
    if (spec.shape === 'offset') query += '&$skip=' + spec.offset;
    return request('GET', '/' + route.entity + '?' + query);
  }
  if (scenario.operation === 'scan')
    return request('POST', '/' + route.action, { cursor: fixture.tables.LargeRows.minID - 1, count: scenario.scanRows, pageSize: scenario.pageSize, iterations: scenario.iterations });
  if (scenario.operation === 'action') {
    if (scenario.lookupPattern) {
      const ids = fixture.tables.LookupRows.ids;
      if (scenario.rows > ids.length) throw new Error('Insufficient lookup keys');
      const lookupIDs = Array.from({ length: scenario.rows }, (_, i) => ids[(vu - 1 + iteration + i) % ids.length]);
      return request('POST', '/' + route.action, { seed: 7, iterations: scenario.iterations, lookupIDs });
    }
    if (route.noop) return request('POST', '/' + route.action, {}, 204);
    return request('POST', '/' + route.action, { seed: 7, iterations: scenario.iterations, calls: scenario.callbacks, ...auxiliaryKeys() });
  }
  throw new Error('Unknown operation: ' + scenario.operation);
}

const prefixes = {
  'cap-baseline': 'NoHandler', 'oyster-idle': 'NoHandler',
  'native-empty': 'NativeEmpty', 'wasm-empty': 'OysterEmpty',
  'native-compute': 'NativeCalculation', 'wasm-compute': 'OysterCalculation',
  'native-compute-read': 'NativeCqlRead', 'wasm-compute-read': 'OysterCqlRead',
  'native-compute-write': 'NativeCqlWrite', 'wasm-compute-write': 'OysterCqlWrite',
};
export function endpoint(s) {
  const prefix = prefixes[s.mode];
  const variant = prefix[0].toLowerCase() + prefix.slice(1);
  if (s.operation === 'scan') return { action: s.mode.startsWith('wasm-') ? 'oysterScan' : 'nativeScan' };
  if (s.operation !== 'action') return { entity: prefix + s.table };
  if (s.lookupPattern) return { action: (s.mode.startsWith('wasm-') ? 'oyster' : 'native') + 'Lookup' + (s.lookupPattern === 'batch' ? 'Batch' : 'Individual') };
  if (s.hookControl) return { action: s.hook ? 'extensionUnimplemented' : 'extensionBypass' };
  if (s.hook) return { action: variant + 'Extension' };
  if (s.access === 'db') return { action: s.mode.endsWith('-read') ? 'nativeDirectRead' : 'nativeDirectWrite' };
  if (prefix === 'NoHandler') return { action: 'noop', noop: true };
  if (s.mode.endsWith('-empty')) return { action: s.mode.startsWith('wasm-') ? 'oysterNoop' : 'nativeNoop', noop: true };
  return { action: variant };
}
