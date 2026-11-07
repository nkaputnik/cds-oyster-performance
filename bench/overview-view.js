const { oysterHandler } = require('./report-view.js');
const { summarize } = require('./report.js');
const { types } = require('./overview-input.js');
const fmt = (n, signed = false, digits = 3) => Number.isFinite(n) ? (signed && n > 0 ? '+' : '') + n.toFixed(digits) : 'not measured';
const envName = type => type.startsWith('local') ? 'Local' : 'BTP';
const table = (headers, rows) => ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |', ...rows.map(row => '| ' + row.join(' | ') + ' |')].join('\n');
const spec = (suffix, operation = 'action', extra = {}) => ({ mode: 'wasm-' + suffix, operation, hook: false, load: 1, ...extra });
function renderOverview({ inputs, data, reportLinks, evidenceLink, comparisonsLink, detailsLink, sourceRoot }) {
  const blocks = ['# Oyster Performance', table(['Local short', 'Local long', 'BTP short', 'BTP long'], [[...['local-short', 'local-long', 'btp-short', 'btp-long'].map(t => '[Report](' + reportLinks[t] + ')')]])];
  const add = text => blocks.push(text);
  const pick = (type, criteria) => {
    const rows = data[type].filter(row => Object.entries(criteria).every(([field, value]) => ((field === 'load' ? row.load?.value : row.scenario[field]) ?? null) === (value ?? null)));
    return rows.length === 1 ? rows[0] : null;
  };
  const counterpart = (type, row) => data[type].find(r => r.key === row?.key);
  const linked = (title, row) => row ? oysterHandler({ ...row.scenario, sourceRoot }, title) : title;
  const metrics = row => ['nativeMeanMs', 'oysterMeanMs', 'extraMeanMs'].map(m => fmt(row?.[m], m.startsWith('extra')));
  const comparisonTable = definitions => {
    const rows = definitions.flatMap(([title, criteria]) => {
      const cloud = pick('btp-long', criteria), local = counterpart('local-long', cloud);
      return cloud && local ? [[linked(title, cloud), ...metrics(local), fmt(local.overheadPercent, true, 1) + '%', ...metrics(cloud), fmt(cloud.overheadPercent, true, 1) + '%']] : [];
    });
    if (rows.length) add(table(['Work per request', 'Local native ms', 'Local Oyster ms', 'Local extra ms', 'Local overhead', 'BTP native ms', 'BTP Oyster ms', 'BTP extra ms', 'BTP overhead'], rows));
    else add('No identical eligible workloads in the selected long runs for this comparison.');
  };
  const constraints = [];
  for (const lookup of [false, true]) for (const [operation, hook, name] of [['create', false, 'INSERT'], ['update', false, 'UPDATE'], ['action', false, 'Action'], ['action', true, 'Predefined extension point']]) for (const outcome of ['accepted', 'rejected'])
    constraints.push([name + (lookup ? ' + lookup' : '') + ', ' + outcome, spec('validate' + (lookup ? '-read' : ''), operation, { hook, validationOutcome: outcome })]);
  const opening = [['Empty action', spec('empty')], constraints[0], constraints[2], constraints[6], constraints[14], ['READ 1,000 rows, empty after handler', spec('empty', 'read', { table: 'LargeRows', rows: 1000 })]];
  const range = type => {
    const costs = constraints.map(([, criteria]) => pick(type, criteria)).filter(Boolean).map(row => row.extraMeanMs);
    return costs.length ? fmt(Math.min(...costs)) + '–' + fmt(Math.max(...costs)) + ' ms' : 'not measured';
  };
  add('Ordinary business constraints add **' + range('local-long') + ' locally** and **' + range('btp-long') + ' in BTP**, compared with equivalent native logic in the selected long runs. Empty invocations, large returned results, database callbacks and concurrent traffic have different costs and need separate latency budgets.');
  add('SAP Cloud Application Programming Model (CAP) supplies the services. CDS-Oyster runs untrusted extension logic in an isolated WebAssembly runtime. Native JavaScript provides the measurement reference for equivalent work. These findings help application owners define extension points and bound the data and work each invocation receives.');
  add('The opening table uses one concurrent client and the long runs. Each native/Oyster pair shares its workload, database and request path within its environment. Extra milliseconds are Oyster minus native. Percentages are calculated within each repetition pair, then averaged with equal weights. Both absolute times are retained so the overhead can be assessed against the request baseline.');
  comparisonTable(opening);
  add('These are measured individual handler paths. A complete application request that composes multiple extension points is not measured here. Use the added milliseconds alongside that application’s own native request time.');
  add('**Blue: native. Orange: Oyster.** Lower bars mean shorter request times.');
  for (const type of ['local-long', 'btp-long']) {
    const selected = [constraints[6], constraints[14]].map(([, c]) => pick(type, c)).filter(Boolean);
    if (!selected.length) continue;
    const values = selected.flatMap(r => [r.nativeMeanMs, r.oysterMeanMs]);
    const labels = selected.flatMap(r => ['Native ' + (r.scenario.mode.endsWith('-read') ? 'limit + lookup' : 'fixed limit'), 'Oyster ' + (r.scenario.mode.endsWith('-read') ? 'limit + lookup' : 'fixed limit')]);
    const css = values.map((_, i) => '.bar-plot-0 rect:nth-child(' + (i + 1) + ') { fill: ' + (i % 2 ? '#ea580c' : '#2563eb') + '; }').join(' ');
    const fence = String.fromCharCode(96).repeat(3);
    add(fence + 'mermaid\n---\nconfig:\n  xyChart:\n    width: 1100\n    height: 420\n  themeCSS: ' + JSON.stringify(css) + '\n---\nxychart-beta\n    title ' + JSON.stringify(envName(type) + ': accepted extension-point constraints') + '\n    x-axis ' + JSON.stringify(labels) + '\n    y-axis "Mean request time (ms)" 0 --> ' + (Math.max(...values) * 1.1) + '\n    bar ' + JSON.stringify(values) + '\n' + fence);
  }
  add('## Ordinary constraints and empty handlers');
  add('Each constraint checks quantity × unitPrice against 1,000. The lookup variant retrieves the limit with one query. Accepted writes persist data; rejected writes return the expected HTTP 400 response and leave stored rows unchanged. Expected business rejections count as successful test outcomes. Request shape and persistence affect the native baseline, so one percentage cannot describe every path.');
  comparisonTable(constraints);
  comparisonTable([['Empty INSERT before handler', spec('empty', 'create')], ['Empty UPDATE before handler', spec('empty', 'update')], ['Empty READ after handler, 10 rows', spec('empty', 'read', { table: 'SmallRows', rows: 10 })], ['Empty predefined extension point', spec('empty', 'action', { hook: true })]]);
  add('An empty handler still enters the isolation path and handles event data. The measured cost varies by event and payload. Treat it as a workload-specific starting cost; the short/long comparison below retains the observed repetition range.');
  add('## Database callbacks and equivalent batching');
  add('Sequential statement actions repeat an indexed read or write once or 10 times without synthetic arithmetic. The separate batching comparison retrieves the same 10 distinct keys and checked result through 10 individual queries or one batched query.');
  const callbacks = [['One indexed read', spec('compute-read', 'action', { callbacks: 1, lookupPattern: null })], ['10 sequential reads', spec('compute-read', 'action', { callbacks: 10, lookupPattern: null })], ['One indexed write', spec('compute-write', 'action', { callbacks: 1 })], ['10 sequential writes', spec('compute-write', 'action', { callbacks: 10 })], ['10 keys, individual queries', spec('compute-read', 'action', { lookupPattern: 'individual' })], ['10 keys, one batch query', spec('compute-read', 'action', { lookupPattern: 'batch' })]];
  comparisonTable(callbacks);
  const increments = [];
  for (const io of ['read', 'write']) for (const type of ['local-long', 'btp-long']) {
    const one = pick(type, spec('compute-' + io, 'action', { callbacks: 1, lookupPattern: null })), ten = pick(type, spec('compute-' + io, 'action', { callbacks: 10, lookupPattern: null }));
    if (!one || !ten) continue;
    const pairs = one.pairs.flatMap(left => { const right = ten.pairs.find(p => p.repetition === left.repetition); return right ? [{ native: (right.nativeMeanMs - left.nativeMeanMs) / 9, oyster: (right.oysterMeanMs - left.oysterMeanMs) / 9 }] : []; });
    if (pairs.length) increments.push([io.toUpperCase(), envName(type), fmt(summarize(pairs.map(p => p.native)).mean), fmt(summarize(pairs.map(p => p.oyster)).mean), fmt(summarize(pairs.map(p => p.oyster - p.native)).mean, true)]);
  }
  if (increments.length) add(table(['Additional sequential statement', 'Environment', 'Native increment ms', 'Oyster increment ms', 'Extra increment ms'], increments));
  add('The estimate divides the one-to-10 increase by nine within matching repetitions and subtracts the native increment. It includes query execution and request processing; it is not an internal callback timer.');
  for (const type of ['local-long', 'btp-long']) {
    const individual = pick(type, callbacks[4][1]), batch = pick(type, callbacks[5][1]);
    if (individual && batch) add(envName(type) + ' batching changes the Oyster mean from ' + fmt(individual.oysterMeanMs) + ' to ' + fmt(batch.oysterMeanMs) + ' ms (' + fmt(100 * (batch.oysterMeanMs - individual.oysterMeanMs) / individual.oysterMeanMs, true, 1) + '%). The native mean changes from ' + fmt(individual.nativeMeanMs) + ' to ' + fmt(batch.nativeMeanMs) + ' ms.');
  }
  add('Design extension contracts that make required data available together and permit equivalent batching. The measured query pattern establishes the gain or loss for these requests, rather than a universal per-query constant.');
  add('## Result volume and arithmetic');
  const volume = [['READ returns 10 rows, empty after handler', spec('empty', 'read', { table: 'LargeRows', rows: 10 })], opening[5], ['READ loops over 1,000 rows', spec('compute', 'read', { table: 'LargeRows', rows: 1000 })], ...[10000, 50000].map(n => ['Scan processes ' + n.toLocaleString('en-US') + ' rows', spec('compute', 'scan', { scanRows: n, scanCoordination: null })])];
  comparisonTable(volume);
  add('Stored table size and returned result size are different inputs. Empty after-READ handlers measure result handling; arithmetic variants add work per row. Bound the rows and fields passed to extension logic and budget bulk processing separately from small invocations.');
  const whole = [];
  for (const type of ['local-long', 'btp-long']) for (const row of data[type].filter(r => r.scenario.wholeScanRows && r.nativeSeconds != null && r.oysterSeconds != null))
    whole.push([envName(type), row.scenario.wholeScanRows, fmt(row.nativeSeconds), fmt(row.oysterSeconds), fmt(row.extraSeconds, true)]);
  if (whole.length) add(table(['Complete scan', 'Rows', 'Native elapsed s', 'Oyster elapsed s', 'Extra elapsed s'], whole));
  add('Complete scans use elapsed time across successive scan requests. They are separate from ordinary per-request latency. Inspect the detailed reports for page size and correctness checks, and compare this total work with the application’s response-time requirements.');
  comparisonTable([100, 10000].map(iterations => [iterations.toLocaleString('en-US') + ' synthetic action iterations', spec('compute', 'action', { iterations })]));
  add('Synthetic arithmetic is a stress input, separate from ordinary business constraints. Its observed gap includes execution inside WebAssembly as well as invocation and CAP integration.');
  add('## Concurrent and mixed traffic');
  add('Each client sends its next request after the previous response. Mean and p95 are per-request values; p95 is the time within which 95% of requests finish. Its difference compares the two request percentiles. Throughput counts successful requests.');
  const concurrent = [];
  for (const mixed of [false, true]) for (const load of [1, 8, 32]) {
    const cloud = pick('btp-long', spec('compute-read', mixed ? 'read' : 'action', { mixed: mixed || null, callbacks: 1, lookupPattern: null, load }));
    for (const type of ['local-long', 'btp-long']) {
      const row = counterpart(type, cloud); if (!row) continue;
      concurrent.push([mixed ? 'Mixed READ/INSERT/UPDATE/action' : 'One-read action', envName(type), load, ...metrics(row), fmt(row.nativeP95Ms), fmt(row.oysterP95Ms), fmt(row.extraP95Ms, true), fmt(row.nativeRps, false, 1), fmt(row.oysterRps, false, 1)]);
    }
  }
  if (concurrent.length) add(table(['Traffic', 'Environment', 'Clients', 'Native mean ms', 'Oyster mean ms', 'Extra mean ms', 'Native p95 ms', 'Oyster p95 ms', 'Extra p95 ms', 'Native requests/s', 'Oyster requests/s'], concurrent));
  add('Assess throughput gains alongside response-time increases as concurrency rises. Where more clients yield little additional throughput, adding concurrency alone does not preserve low-load latency. These fixed-deployment observations neither forecast production capacity nor identify an internal sandbox bottleneck.');
  add('## Short versus long: agreement and variability');
  add('Only identical workloads are compared. The range is the minimum and maximum of paired added-time observations in the long run, not a confidence interval. A single short repetition cannot establish repeat variability.');
  const repeat = [];
  for (const [title, criteria] of [opening[0], opening[1], opening[4], callbacks[1], volume[2], volume[3]]) for (const environment of ['local', 'btp']) {
    const long = pick(environment + '-long', criteria), short = counterpart(environment + '-short', long);
    if (long && short) repeat.push([title, envName(environment), ...metrics(short), ...metrics(long), fmt(long.extraMinMs) + '–' + fmt(long.extraMaxMs)]);
  }
  if (repeat.length) add(table(['Matched workload', 'Environment', 'Short native ms', 'Short Oyster ms', 'Short extra ms', 'Long native ms', 'Long Oyster ms', 'Long extra ms', 'Long extra range ms'], repeat));
  const signs = [];
  for (const environment of ['local', 'btp']) for (const [title, criteria] of constraints) {
    const long = pick(environment + '-long', criteria), short = counterpart(environment + '-short', long);
    if (long && short && short.extraMeanMs < 0 && long.pairs.every(p => p.extraMeanMs > 0)) signs.push(envName(environment) + ' ' + title);
  }
  if (signs.length) add('Short has a negative mean difference while every long pair is positive for: ' + signs.join('; ') + '. The short result alone does not support a negative overhead conclusion for these paths.');
  add('Use short to inspect correctness and broad effects. Prefer repeated long measurements and their ranges for overhead estimates. Repetitions in one run do not characterize variation across days, hardware sizes or other tenants.');
  add('## Setup and evidence');
  add(table(['Run', 'Started (UTC)', 'Records', 'Repetitions', 'Warmup / measurement s', 'Recorded interval min', 'Node', 'Request path'], types.map(type => { const m = inputs[type].manifest; return ['[' + type + '](' + reportLinks[type] + ')', m.startedAt, inputs[type].results.length, m.settings.repetitions, m.settings.warmup + ' / ' + m.settings.duration, fmt((Date.parse(m.finishedAt) - Date.parse(m.startedAt)) / 60000, false, 1), m.environment?.node || 'unspecified', m.environment?.network?.path || 'Local HTTP']; })));
  const peak = (results, area, field) => { const values = results.map(r => r[area]?.[field]).filter(Number.isFinite); return values.length ? Math.max(...values) : null; };
  add(table(['Run', 'Provider RSS peak MiB', 'Generator RSS peak MiB'], types.map(type => [type, fmt(peak(inputs[type].results, 'resources', 'rssPeakMiB'), false, 1), fmt(peak(inputs[type].results, 'generatorResources', 'rssPeakMiB'), false, 1)])));
  add('Resource peaks are sampled process observations. Missing generator samples are shown explicitly. RSS alone does not establish available capacity or identify the limiting component.');
  add('The selected BTP runs use a subscribed HANA tenant and a generator in a separate CF container. Native and Oyster pairs share the provider and tenant within BTP. Local runs use SQLite with the server and generator on the same machine. Cross-environment differences combine hardware, database, authentication and request-path effects; they do not isolate one infrastructure cost.');
  const normalize = (hashes, marker) => Object.fromEntries(Object.entries(hashes || {}).filter(([path]) => path.includes(marker)).map(([path, hash]) => [path.slice(path.indexOf(marker)), hash]));
  const local = inputs['local-long'].manifest, cloud = inputs['btp-long'].manifest;
  for (const [label, left, right] of [['Oyster handlers', normalize(local.environment?.sourceHashes, 'srv/Benchmark'), normalize(cloud.environment?.sourceHashes, 'srv/Benchmark')], ['Fixture CSVs', normalize(local.fixture?.hashes, 'perf-'), normalize(cloud.fixture?.hashes, 'perf-')]]) {
    const names = new Set([...Object.keys(left), ...Object.keys(right)]), matched = [...names].filter(name => left[name] && left[name] === right[name]);
    add(label + ': ' + matched.length + ' of ' + names.size + ' recorded source identities match between the selected local and BTP long runs.' + (matched.length !== names.size ? ' Source differences limit attributing cross-environment changes to infrastructure alone.' : ''));
  }
  add('[Exact paired observations](' + comparisonsLink + ') retain every native/Oyster pair and repetition. [All workload summaries](' + detailsLink + ') retain matching dimensions, counts and ranges. [Input selection and hashes](' + evidenceLink + ') identify the selected runs. The four linked reports retain the full scenario charts, resource metrics and validation decisions.');
  add('Define extension points with bounded input and result sizes, permit equivalent batching, and assess added per-call milliseconds against the complete application. Untrusted logic continues to require Oyster isolation; native logic is the performance reference. Concurrent and bulk workloads need their own budgets. No internal sandbox component, startup overhead or production capacity is inferred from these timings.');
  return blocks.join('\n\n') + '\n';
}
function renderDetails(data) {
  return ['# Supporting workload comparisons', 'Equal-weight averages of exact native/Oyster repetition pairs. Ranges are observed minima and maxima, not confidence intervals. Whole-table elapsed times are separate from per-request means.',
    ...types.flatMap(type => ['## ' + type, table(['Workload', 'Clients', 'Pairs', 'Native mean ms', 'Oyster mean ms', 'Extra mean ms', 'Extra range ms', 'Overhead', 'Native p95 ms', 'Oyster p95 ms', 'Extra p95 ms', 'Native requests/s', 'Oyster requests/s', 'Native scan s', 'Oyster scan s'], data[type].map(row => [(row.scenario.id || row.key).replaceAll('|', ' / ') + (row.scenario.mixed ? ' [mixed traffic]' : ''), row.load?.value ?? 'unspecified', row.n, ...['nativeMeanMs', 'oysterMeanMs', 'extraMeanMs'].map(m => fmt(row[m])), fmt(row.extraMinMs) + '–' + fmt(row.extraMaxMs), fmt(row.overheadPercent, true, 1) + '%', ...['nativeP95Ms', 'oysterP95Ms', 'extraP95Ms', 'nativeRps', 'oysterRps', 'nativeSeconds', 'oysterSeconds'].map(m => fmt(row[m]))]))])].join('\n\n') + '\n';
}
module.exports = { renderOverview, renderDetails };
