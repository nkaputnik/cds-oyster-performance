const MODES = ['cap-baseline', 'oyster-idle', 'native-empty', 'wasm-empty',
  'native-compute', 'wasm-compute', 'native-compute-read', 'wasm-compute-read',
  'native-compute-write', 'wasm-compute-write',
  'native-validate', 'wasm-validate', 'native-validate-read', 'wasm-validate-read'];
const OPERATIONS = ['create', 'update', 'read', 'action', 'scan'];
function callbackBudget(s) {
  if (!s.mode.startsWith('wasm-')) return 0;
  if (s.mode.includes('validate')) return s.mode.endsWith('-read') ? 1 : 0;
  if (s.lookupPattern) return s.lookupPattern === 'batch' ? 1 : s.rows;
  if (s.operation === 'scan') return Math.ceil(s.scanRows / s.pageSize);
  if (!s.mode.endsWith('-read') && !s.mode.endsWith('-write')) return 0;
  if (s.operation === 'read' && s.mode.endsWith('-write')) return 2 * s.callbacks;
  return s.callbacks * (s.operation === 'read' && !s.hook && s.enrichment === 'per-row' ? s.rows : 1);
}

function scenario(input = {}) {
  const s = { mode: 'cap-baseline', operation: 'action', table: 'SmallRows', rows: 10,
    iterations: input.mode?.includes('compute-') || input.mode?.includes('validate') ? 0 : 100, callbacks: 1, access: 'service', hook: false, pageSize: 1000,
    scanRows: 10000, enrichment: 'batch', queryShape: 'page', offset: 0, hookControl: false, actionContract: 'auto', lookupPattern: null, expectedFailure: null, validationOutcome: null, ...input };
  if (!MODES.includes(s.mode)) throw new Error('Unknown mode: ' + s.mode);
  if (!OPERATIONS.includes(s.operation)) throw new Error('Unknown operation: ' + s.operation);
  if (s.mode.includes('validate')) {
    if (!['create', 'update', 'action'].includes(s.operation) || s.access !== 'service' || s.iterations !== 0)
      throw new Error('Invalid validation workload');
    s.validationOutcome ??= 'accepted';
    if (!['accepted', 'rejected'].includes(s.validationOutcome)) throw new Error('Unknown validation outcome');
  } else if (s.validationOutcome !== null) throw new Error('Validation outcome requires validation mode');
  if (!['SmallRows', 'LargeRows', 'WriteRows'].includes(s.table)) throw new Error('Unknown table');
  if (!['service', 'db'].includes(s.access)) throw new Error('Unknown access');
  if (s.access === 'db' && !s.mode.startsWith('native-')) throw new Error('Direct DB access requires native mode');
  if (!['page', 'key', 'range', 'non-indexed', 'offset'].includes(s.queryShape)) throw new Error('Unknown queryShape');
  for (const key of ['rows', 'iterations', 'callbacks', 'pageSize', 'scanRows', 'offset'])
    if (!Number.isSafeInteger(s[key]) || s[key] < 0) throw new Error('Invalid ' + key);
  if (!s.pageSize || !s.rows) throw new Error('rows and pageSize must be positive');
  if (s.lookupPattern && (!['individual', 'batch'].includes(s.lookupPattern) || s.operation !== 'action'
    || !['native-compute-read', 'wasm-compute-read'].includes(s.mode) || s.hook || s.access !== 'service' || s.rows > 1000))
    throw new Error('Invalid fixed lookup pattern');
  if (s.queryShape !== 'offset' && s.offset !== 0) throw new Error('Nonzero offset requires queryShape offset');
  if (s.operation === 'read' && s.queryShape === 'key') s.rows = 1;
  if (!['auto', 'compute'].includes(s.actionContract)) throw new Error('Unknown actionContract');
  s.expectedCallbacks = callbackBudget(s);
  if (s.expectedCallbacks > 100 && !s.expectedFailure)
    throw new Error('Callbacks above default limit require an expected failure scenario');
  if (s.mode.startsWith('wasm-') && s.operation === 'scan' && s.pageSize > 1000 && !s.expectedFailure)
    throw new Error('Callback rows above default limit require an expected failure scenario');
  if (s.rows > 10000) throw new Error('READ exceeds the declared CAP query limit');
  if (s.operation === 'create' || s.operation === 'update') s.table = 'WriteRows';
  if (s.operation === 'scan') s.table = 'LargeRows';
  s.id = [s.operation, s.table, s.mode, s.hook ? 'hook' : 'direct', s.access,
    'rows' + s.rows, 'cpu' + s.iterations, 'calls' + s.callbacks,
    s.operation === 'scan' ? 'scan' + s.scanRows + '-page' + s.pageSize : s.enrichment].join('/');
  if (s.operation === 'read') s.id += '/query-' + s.queryShape + '-offset' + s.offset;
  if (s.hookControl) s.id += '/hook-control';
  if (s.actionContract !== 'auto') s.id += '/contract-' + s.actionContract;
  if (s.lookupPattern) s.id += '/lookup-' + s.lookupPattern;
  if (s.validationOutcome) s.id += '/decision-' + s.validationOutcome;
  return s;
}

function matrix(modes, operations, extra = {}) {
  return modes.flatMap(mode => operations.map(operation => scenario({ mode, operation, ...extra })));
}

function suite(name) {
  if (!['short', 'long'].includes(name)) throw new Error('Unknown suite: ' + name);
  const core = [
    ...matrix(MODES.slice(0, 4), ['create', 'update', 'read', 'action']),
    ...matrix(MODES.slice(6, 10), ['create', 'update', 'read', 'action']),
    ...['accepted', 'rejected'].flatMap(validationOutcome => [
      ...matrix(MODES.slice(10), ['create', 'update', 'action'], { validationOutcome }),
      ...matrix(MODES.slice(10), ['action'], { validationOutcome, hook: true }),
    ]),
    ...matrix(['native-compute', 'wasm-compute'], ['action']),
    ...matrix(['native-compute', 'wasm-compute'], ['create', 'update']),
    ...matrix(MODES.slice(0, 4), ['read'], { table: 'LargeRows' }),
    ...matrix(MODES.slice(0, 4), ['read'], { table: 'LargeRows', rows: 1000 }),
    ...matrix(MODES.slice(2, 4), ['action'], { hook: true, actionContract: 'compute', iterations: 0 }),
    ...matrix(MODES.slice(6, 10), ['action'], { hook: true, actionContract: 'compute' }),
    ...[false, true].map(hook => scenario({ mode: 'oyster-idle', operation: 'action', hook, hookControl: true, actionContract: 'compute' })),
    ...[10, 1000].flatMap(rows => matrix(['native-compute', 'wasm-compute'], ['read'], { table: 'LargeRows', rows })),
    ...matrix(['native-compute', 'wasm-compute'], ['scan'], { scanRows: 10000 }),
    ...matrix(['native-compute-read', 'native-compute-write'], ['action'], { access: 'db' }),
    ...matrix(['native-compute-read', 'wasm-compute-read', 'native-compute-write', 'wasm-compute-write'], ['action'], { callbacks: 10 }),
    ...['individual', 'batch'].flatMap(lookupPattern => matrix(['native-compute-read', 'wasm-compute-read'], ['action'], { lookupPattern })),
    ...['cap-baseline', 'native-compute-read', 'wasm-compute-read'].flatMap(mode => [8, 32].map(value =>
      scenario({ mode, operation: 'action', benchmarkLoad: { kind: 'vus', value } }))),
  ];
  if (name === 'long') core.push(
    ...matrix(['native-compute', 'wasm-compute'], ['action'], { iterations: 10000 }),
    ...matrix(['native-compute', 'wasm-compute'], ['scan'], { scanRows: 50000 }),
    ...['cap-baseline', 'native-compute-read', 'wasm-compute-read'].flatMap(mode => [1, 8, 32].map(value =>
      scenario({ mode, operation: 'read', mixed: true, benchmarkLoad: { kind: 'vus', value } }))),
  );
  return core;
}

function cloudSuite(name) {
  const selected = [], seen = new Set();
  for (const source of suite(name)) {
    const { id, expectedCallbacks, benchmarkLoad, ...work } = source;
    if (work.mode === 'cap-baseline') work.mode = 'oyster-idle';
    const s = scenario(work);
    const load = benchmarkLoad || { kind: 'vus', value: 1 };
    const key = JSON.stringify([work, load.kind, load.value]);
    if (seen.has(key)) continue;
    seen.add(key);
    if (benchmarkLoad) s.benchmarkLoad = { ...benchmarkLoad };
    selected.push(s);
  }
  return selected;
}

function shuffled(items, seed = 42) {
  const result = [...items];
  let state = seed >>> 0;
  for (let i = result.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = state % (i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

module.exports = { MODES, callbackBudget, scenario, suite, cloudSuite, shuffled };
