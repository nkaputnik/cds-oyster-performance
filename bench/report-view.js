const { endpoint } = require('./requests.js');

const NL = String.fromCharCode(10);
const chartColors = { control: '#64748b', native: '#2563eb', oyster: '#ea580c' };
function chartGroup(label) {
  if (label.includes('no handler')) return 'control';
  if (label.includes('Native')) return 'native';
  if (label.includes('Oyster')) return 'oyster';
  return 'control';
}
const modes = {
  'cap-baseline': 'Plain CAP', 'oyster-idle': 'Oyster enabled, no handler',
  'native-empty': 'Native empty handler', 'wasm-empty': 'Oyster empty handler',
  'native-compute': 'Native calculation', 'wasm-compute': 'Oyster calculation',
  'native-compute-read': 'Native calculation + CQL read', 'wasm-compute-read': 'Oyster calculation + CQL read',
  'native-compute-write': 'Native calculation + CQL write', 'wasm-compute-write': 'Oyster calculation + CQL write',
  'native-validate': 'Native constraint', 'wasm-validate': 'Oyster constraint',
  'native-validate-read': 'Native constraint + lookup', 'wasm-validate-read': 'Oyster constraint + lookup',
};
function modeLabel(s) {
  if (s.iterations === 0 && s.mode.includes('compute-')) return modes[s.mode].replace('calculation + ', '');
  return modes[s.mode];
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
const count = value => finite(value) ? value.toLocaleString('en-US') : 'unspecified';
const number = value => {
  if (!finite(value)) return 'not measured';
  const rounded = Number(value.toFixed(3));
  return String(value !== 0 && rounded === 0 ? Number(value.toPrecision(3)) : rounded);
};
const signed = value => finite(value) ? (value > 0 ? '+' : '') + number(value) : 'not measured';
const safe = value => String(value).replaceAll('|', ' / ').replaceAll(NL, ' ').replaceAll(String.fromCharCode(13), ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const quoted = value => JSON.stringify(String(value).replaceAll(NL, ' '));
function table(headers, rows) {
  return ['| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...rows.map(row => '| ' + row.map(safe).join(' | ') + ' |')].join(NL);
}
function operation(s) {
  if (s.scanCoordination === 'external') return 'READ loop over ' + count(s.wholeScanRows) + ' rows';
  if (s.operation === 'scan') return 'READ loop over ' + count(s.scanRows) + ' rows';
  const name = { create: 'INSERT', update: 'UPDATE', read: 'READ', action: 'Action', memory: 'Memory allocation' }[String(s.operation).toLowerCase()] || 'Request';
  return name === 'READ' ? 'READ ' + count(s.rows) + ' rows from ' + (s.table === 'LargeRows' ? 'million-row table' : '1,000-row table') : name;
}
function oysterHandler(s, label = operation(s)) {
  const mode = s.mode?.replace(/^native-/, 'wasm-');
  if (!mode?.startsWith('wasm-') || s.hookControl) return safe(label);
  if (s.mixed) return ['read', 'create', 'update', 'action'].map(operation =>
    oysterHandler({ ...s, mode, mixed: false, operation,
      table: operation === 'read' ? s.readTable || 'SmallRows' : 'WriteRows' },
    label + ': ' + ({ read: 'READ', create: 'INSERT', update: 'UPDATE', action: 'action' })[operation])).join(', ');
  const route = endpoint({ ...s, mode });
  const service = s.hook ? 'BenchmarkExtensionService' : 'BenchmarkService';
  const file = route.entity
    ? route.entity + '/' + ({ create: 'before-CREATE', update: 'before-UPDATE', read: 'after-READ' })[s.operation]
    : 'on-' + route.action.replace(/Extension$/, '');
  return '[' + safe(label) + '](' + (s.sourceRoot || '../../apps/extension/srv/') + service + '/' + file + '.js)';
}

function oysterSources(scenarios) {
  const links = [...new Set(scenarios.filter(s => s?.mode?.startsWith('wasm-')).map(s => oysterHandler(s, modeLabel(s) || s.mode)))];
  return links.length ? 'Oyster handlers: ' + links.join(', ') + '.' : '';
}

function description(s, question) {
  const op = String(s.operation).toLowerCase();
  let text = op === 'create' ? 'Inserts one row.' : op === 'update' ? 'Updates one existing row.'
    : op === 'read' ? 'Reads ' + count(s.rows) + ' rows from the ' + (s.table === 'LargeRows' ? 'million-row' : '1,000-row') + ' table.'
    : op === 'scan' ? 'Reads pages of ' + count(s.pageSize) + ' rows and performs arithmetic on each row.'
    : 'Calls an action and waits for it to finish.';
  if (s.validationOutcome) return text + ' Checks quantity × unitPrice against ' + (s.mode.endsWith('-read') ? 'a limit retrieved by one database query' : 'a fixed limit of 1,000')
    + '. Measures ' + s.validationOutcome + ' requests' + (s.hook ? ' through a predefined extension point' : '') + ', without a synthetic calculation loop.';
  if (op === 'read') {
    const query = { key: ' Uses an indexed key lookup.', range: ' Uses an indexed ID range.',
      'non-indexed': ' Filters by a non-indexed field.', offset: ' Uses an offset of ' + count(s.offset) + ' rows.',
      page: ' Reads an ordered page.' }[s.queryShape];
    text += query || '';
  }
  if (question === 'Installed plugin overhead') return text + ' Compares plain CAP with Oyster enabled. Neither has custom business logic.';
  if (question === 'Sandbox path versus native handler') return text + ' The handler does nothing. Compares an application handler with an Oyster handler.';
  if (question === 'Unimplemented hook routing') return text + ' Compares calling an unimplemented extension point with bypassing it.';
  if (op === 'scan') text += ' It performs ' + count(s.iterations) + ' calculation iterations for every scanned row. Native code issues the page queries directly. Oyster uses CQL callbacks.';
  if (op !== 'scan' && s.iterations > 0) text += ' The same calculation runs ' + count(s.iterations) + ' iterations ' + (op === 'read' ? 'for every returned row.' : 'per request.');
  if (question.includes('read path')) text += ' It also performs ' + count(s.callbacks) + ' auxiliary CQL ' + (s.callbacks === 1 ? 'read ' : 'reads ') + (op === 'read' && !s.hook && s.enrichment === 'per-row' ? 'for every returned row.' : 'per request.');
  if (question.includes('write path')) text += ' It also performs ' + count(s.callbacks) + ' auxiliary CQL ' + (s.callbacks === 1 ? 'update ' : 'updates ') + (op === 'read' && !s.hook && s.enrichment === 'per-row' ? 'for every returned row.' : 'per request.');
  if (s.hook) text += ' The application invokes the handler through a declared extension point.';
  return text + ' Compares execution in the application with execution in Oyster.';
}
function chart(title, unit, labels, values, kind = 'bar') {
  if (!values.length) return '';
  const lower = Math.min(0, ...values), upper = Math.max(0, ...values);
  const floor = lower < 0 ? Number((lower * 1.1).toPrecision(8)) : 0;
  const ceiling = upper > 0 ? Number((upper * 1.1).toPrecision(8)) : 1;
  const barStyles = kind === 'bar' ? labels.map((label, i) => {
    const color = chartColors[chartGroup(label)];
    return '.bar-plot-0 rect:nth-child(' + (i + 1) + ') { fill: ' + color + '; stroke: ' + color + '; }';
  }).join(' ') : '';
  return ['```mermaid', '---', 'config:', '  xyChart:', '    width: 1400', '    height: 480',
    '    xAxis:', '      labelFontSize: 13', '  themeVariables:', '    xyChart:',
    '      plotColorPalette: ' + quoted(chartColors[chartGroup(title)]),
    '  themeCSS: ' + quoted(barStyles),
    '---', 'xychart-beta', '    title ' + quoted(title),
    '    x-axis [' + labels.map(quoted).join(', ') + ']', '    y-axis ' + quoted(unit) + ' ' + floor + ' --> ' + ceiling,
    '    ' + kind + ' [' + values.join(', ') + ']', '```'].join(NL);
}

function best(rows) {
  return [...rows].sort((a, b) => Number(a.context.scenario.hook) - Number(b.context.scenario.hook)
    || Number(b.context.scenario.operation === 'action') - Number(a.context.scenario.operation === 'action')
    || Number(a.context.scenario.table === 'LargeRows') - Number(b.context.scenario.table === 'LargeRows')
    || (a.context.scenario.rows ?? 0) - (b.context.scenario.rows ?? 0))[0];
}
function loadLabel(result) {
  return count(result.load?.value) + (['rate', 'arrival', 'constant-arrival-rate'].includes(result.load?.kind) ? ' requests/s' : result.load?.value === 1 ? ' concurrent client' : ' concurrent clients');
}

function useCaseCharts(results, { groups, tuples, lowLoad, summarize }) {
  const candidates = results.filter(r => lowLoad(r) && r.scenario.access === 'service'
    && !r.scenario.hookControl && !r.scenario.mixed && r.scenario.scanCoordination !== 'external'
    && r.scenario.callbacks === 1 && !r.scenario.lookupPattern);
  const blocks = [];
  const ordered = groups(candidates).sort((a, b) => {
    const rank = s => ['create', 'update', 'read', 'action', 'scan'].indexOf(s.operation) + (s.hook ? 10 : 0);
    return rank(a[0].scenario) - rank(b[0].scenario)
      || a[0].scenario.table.localeCompare(b[0].scenario.table)
      || a[0].scenario.rows - b[0].scenario.rows;
  });
  for (const group of ordered) {
    const s = group[0].scenario;
    const subject = operation(s) + (s.hook ? ' through an extension point' : '');
    for (const withCql of [false, true]) {
      if (s.operation === 'scan' && withCql) continue;
      const definitions = withCql
        ? [['native-compute-read', 'wasm-compute-read'], ['native-compute-write', 'wasm-compute-write'], ['native-validate-read', 'wasm-validate-read']]
        : [['cap-baseline', 'oyster-idle'], ['native-empty', 'wasm-empty'], ['native-compute', 'wasm-compute'], ['native-validate', 'wasm-validate']];
      const labels = [], values = [], differences = [];
      for (const [base, target] of definitions) {
        const pairs = tuples(group, [r => r.scenario.mode === base, r => r.scenario.mode === target]);
        if (!pairs.length) continue;
        for (const [i, mode] of [base, target].entries()) {
          const value = summarize(pairs.map(pair => pair[i].stats.meanMs)).mean;
          labels.push(modeLabel({ ...s, mode }) + ' (' + number(value) + ' ms)'); values.push(value);
        }
        const diff = summarize(pairs.map(([a, b]) => b.stats.meanMs - a.stats.meanMs)).mean;
        const name = base === 'cap-baseline' ? 'enabling Oyster' : base === 'native-empty' ? 'empty handler'
          : withCql ? (base.endsWith('read') ? 'CQL read' : 'CQL update') : 'calculation';
        differences.push(oysterHandler({ ...s, mode: target }, name) + ': **' + signed(diff) + ' ms**');
      }
      if (!values.length) continue;
      const title = subject + (s.validationOutcome ? ': ' + s.validationOutcome + ' business constraint' : '') + (s.operation === 'scan' ? ' with paged queries' : withCql ? ' with database queries' : ' without callbacks');
      blocks.push('### ' + title, chart(title, 'Mean request time (ms)', labels, values));
      const work = s.validationOutcome ? description({ ...s, mode: withCql ? 'wasm-validate-read' : 'wasm-validate' }, 'Business constraint') : s.operation === 'scan' ? 'Reads pages of ' + count(s.pageSize) + ' rows and performs ' + count(s.iterations) + ' calculation iterations per row. Native queries run through the service; Oyster uses one callback per page.'
        : description(s, withCql ? 'CPU plus auxiliary read path' : labels.some(name => name.startsWith('Native calculation')) ? 'Execution-location penalty for CPU work'
          : labels.some(name => name.startsWith('Native empty')) ? 'Sandbox path versus native handler' : 'Installed plugin overhead')
          + (withCql ? ' The CQL update variant uses ' + count(s.operation === 'read' ? 2 * s.callbacks : s.callbacks) + ' auxiliary statements per request.' : ' Empty handlers skip the calculation; no-handler controls perform only the ordinary request.');
      blocks.push(work + ' Oyster minus its matched control, ' + differences.join('; ') + '.');
    }
  }
  return blocks;
}

function pairedStats(pairs, value, summarize) {
  const values = pairs.map(pair => pair.map(value)).filter(pair => pair.every(finite));
  const before = summarize(values.map(pair => pair[0])).mean;
  const after = summarize(values.map(pair => pair[1])).mean;
  const difference = summarize(values.map(pair => pair[1] - pair[0]));
  return { n: values.length, before, after, delta: difference.mean, sd: difference.sd,
    ratio: summarize(values.map(([a, b]) => a === 0 ? null : b / a)).mean,
    percent: summarize(values.map(([a, b]) => a === 0 ? null : (b - a) / a * 100)).mean };
}

function matched(results, api, before, after, omit = []) {
  return api.groups(results, { omit }).flatMap(group => {
    const pairs = api.tuples(group, [before, after]);
    return pairs.length ? [{ context: pairs[0][1], pairs,
      ...pairedStats(pairs, r => r.stats.meanMs, api.summarize) }] : [];
  });
}
const modeIs = mode => r => r.scenario.mode === mode;
const effect = row => row ? signed(row.delta) + ' ms' + (finite(row.ratio) ? ' (' + number(row.ratio) + '× native time)' : '') : 'Not measured';
const confidence = row => !row ? 'Not measured' : row.n === 1 ? 'One paired run; repeat needed' : row.n + ' paired runs; delta SD ' + number(row.sd) + ' ms';

function loadComparisons(results, api) {
  const rowFor = (context, suffix, pairs) => {
    const stats = name => pairedStats(pairs, r => r.stats?.[name], api.summarize);
    return { context, suffix, pairs, responseTime: stats('meanMs'), latency: stats('p95Ms'), throughput: stats('successfulRps') };
  };
  const rows = [];
  for (const group of api.groups(results.filter(r => r.phase === 'warm' && !r.scenario.hookControl && !r.scenario.lookupPattern))) {
    for (const suffix of ['compute-read', 'compute', 'empty', 'compute-write']) {
      const pairs = api.tuples(group, [modeIs('native-' + suffix), modeIs('wasm-' + suffix)]);
      if (!pairs.length) continue;
      rows.push(rowFor(group[0], suffix, pairs));
    }
  }
  const sweeps = api.groups(rows.map(row => ({ ...row.context, loadRow: row })), { mode: false, omit: ['load'] })
    .flatMap(group => [...new Set(group.map(r => r.load.kind))].map(kind => group.filter(r => r.load.kind === kind).map(r => r.loadRow)));
  // Keep each implementation pair separate, even when their other workload fields match.
  const candidates = sweeps.flatMap(rows => [...new Set(rows.map(r => r.suffix))].map(suffix => rows.filter(r => r.suffix === suffix)))
    .filter(rows => new Set(rows.map(r => r.context.load.value)).size > 1)
    .map(rows => {
      const repetitions = rows[0].pairs.map(pair => pair[0].repetition)
        .filter(rep => rows.every(row => row.pairs.some(pair => pair[0].repetition === rep)));
      return rows.map(row => rowFor(row.context, row.suffix,
        row.pairs.filter(pair => repetitions.includes(pair[0].repetition))));
    })
    .filter(rows => rows[0].pairs.length)
    .sort((a, b) => b.length - a.length || Number(b[0].suffix === 'compute-read') - Number(a[0].suffix === 'compute-read'));
  return { sweep: candidates[0]?.sort((a, b) => a.context.load.value - b.context.load.value) || [], rows };
}

function applicationOverview(ordinary, pointWork, bulk, api, constraints = []) {
  if (constraints.length) {
    const accepted = constraints.filter(r => r.context.scenario.validationOutcome === 'accepted');
    const point = best(accepted.filter(r => r.context.scenario.hook));
    const crud = accepted.filter(r => ['create', 'update'].includes(r.context.scenario.operation));
    const additions = matched(ordinary.filter(r => ['create', 'update'].includes(r.scenario.operation)
      && (!r.scenario.validationOutcome || r.scenario.validationOutcome === 'accepted')), api,
    modeIs('oyster-idle'), modeIs('wasm-validate'), ['iterations', 'validationOutcome']);
    const blocks = [
      table(['Application design', 'Added mean request time', 'Comparison'], [
        ['Predefined extension points', point ? effect(point) + ' per accepted call, ' + oysterHandler(point.context.scenario, 'amount constraint') : 'Not measured.', 'Equivalent native constraint handler'],
        ['CRUD constraints on custom entities', additions.length ? additions.map(r => oysterHandler(r.context.scenario, operation(r.context.scenario)) + ': ' + signed(r.delta) + ' ms').join(', ') : crud.length ? crud.map(r => oysterHandler(r.context.scenario, operation(r.context.scenario)) + ': ' + signed(r.delta) + ' ms').join(', ') : 'Not measured.', additions.length ? 'Oyster enabled, generic CRUD without a handler' : 'Equivalent native constraint handler'],
        ['after-READ calculation on a large collection', bulk ? oysterHandler(bulk.context.scenario) + ': ' + effect(bulk) : 'Not measured.', 'Equivalent native calculation handler'],
      ]),
    ];
    if (additions.length) blocks.push('The custom-entity comparison measures adding an accepted fixed-limit constraint to generic CRUD. It includes the additional quantity and unitPrice request fields. The native/Oyster constraint comparisons above use identical inputs.');
    blocks.push('These are individual ' + (api.cloud ? 'tenant HANA' : 'SQLite') + ' constraint invocations. Measure the complete application to budget requests that invoke several handlers. Synthetic calculations below are stress workloads.');
    return blocks;
  }
  const additions = matched(ordinary.filter(r => !r.scenario.mixed
    && ['create', 'update', 'read'].includes(r.scenario.operation)
    && (r.scenario.operation !== 'read' || r.scenario.rows <= 10)), api,
  modeIs('oyster-idle'), modeIs('wasm-compute'));
  const crud = ['create', 'update', 'read'].map(op => best(additions.filter(r => r.context.scenario.operation === op))).filter(Boolean);
  const point = best(pointWork.filter(r => r.context.scenario.mode === 'wasm-compute-read')) || best(pointWork);
  const pointRange = pointWork.length ? signed(Math.min(...pointWork.map(r => r.delta)))
    + ' to ' + signed(Math.max(...pointWork.map(r => r.delta))) + ' ms' : 'Not measured: matching bounded extension-point work is missing.';
  const blocks = [
    pointWork.length
      ? '**One small extension-point call added ' + pointRange + '** compared with the same work in a native handler. The tested work was an arithmetic calculation, with zero or one auxiliary database query.'
      : 'The cost of a small extension-point call is not measured in this run.',
    table(['Application design', 'Added mean request time', 'Comparison'], [
      ['Predefined extension points',
        pointWork.length ? pointRange + ' per call. ' + pointWork.map(r => oysterHandler(r.context.scenario, modes[r.context.scenario.mode].replace('Oyster ', ''))).join(', ') + '.' : pointRange,
        'Equivalent native handler'],
      ['CRUD handlers on custom entities',
        crud.length ? crud.map(r => oysterHandler(r.context.scenario, r.context.scenario.operation === 'read' ? 'READ (' + count(r.context.scenario.rows) + ' rows)' : operation(r.context.scenario)) + ': ' + signed(r.delta) + ' ms').join(', ') + '. Small calculation, no auxiliary queries.' : 'Not measured: matching CRUD controls are missing.',
        'Oyster enabled and no handler'],
      ['after-READ calculation on a large collection',
        bulk ? oysterHandler(bulk.context.scenario) + ': ' + effect(bulk) + '. ' + count(bulk.context.scenario.iterations) + ' calculation iterations per returned row.' : 'Not measured: matching large-result handlers are missing.',
        'Equivalent native handler'],
    ]),
  ];
  blocks.push('These are low-load ' + (api.cloud ? 'tenant HANA' : 'SQLite') + ' measurements of individual handlers. A complete business application, multiple extension calls in one request, and registration and startup costs were not measured. Concurrent load reveals how throughput and request latency change together.');
  return blocks;
}

function buildHumanReport(manifest, results, api) {
  const cloud = manifest.environment?.execution === 'cloud';
  api = { ...api, cloud };
  const { groups, tuples, summarize, lowLoad, eligible, validationIssues } = api;
  const invalid = validationIssues(manifest.validation).length > 0;
  const transport = results.some(r => r.transport === 'http') ? 'http' : 'service';
  const primary = invalid ? [] : results.filter(r => r.transport === transport);
  const low = primary.filter(r => lowLoad(r) && !r.scenario.hookControl && r.scenario.scanCoordination !== 'external');
  const ordinary = low.filter(r => !r.scenario.hook && !r.scenario.lookupPattern);
  const pairsFor = (a, b, rows = ordinary) => matched(rows, api, modeIs(a), modeIs(b));
  const empty = pairsFor('native-empty', 'wasm-empty');
  const idle = pairsFor('cap-baseline', 'oyster-idle');
  const calculation = pairsFor('native-compute', 'wasm-compute');
  const constraints = ['validate', 'validate-read'].flatMap(kind => matched(low, api, modeIs('native-' + kind), modeIs('wasm-' + kind)));
  const lightweight = empty.filter(row => ['create', 'update', 'read', 'action'].includes(row.context.scenario.operation)
    && (row.context.scenario.operation !== 'read' || row.context.scenario.rows <= 10));
  const overhead = best(lightweight);
  const bulk = calculation.filter(row => row.context.scenario.operation === 'read').sort((a, b) => b.context.scenario.rows - a.context.scenario.rows)[0];
  const scan = calculation.filter(row => row.context.scenario.operation === 'scan').sort((a, b) => b.context.scenario.scanRows - a.context.scenario.scanRows)[0];
  const bulkGroup = bulk && groups(ordinary).find(group => group.includes(bulk.context));
  const bulkControls = bulkGroup ? tuples(bulkGroup, ['native-empty', 'wasm-empty', 'native-compute', 'wasm-compute'].map(modeIs)) : [];
  const io = ['read', 'write'].flatMap(kind => pairsFor('native-compute-' + kind, 'wasm-compute-' + kind));
  const representative = overhead || best(constraints) || best(calculation) || best(io);
  const fanout = api.fanoutEvidence(primary);
  const batching = best(matched(low.filter(r => r.scenario.mode === 'wasm-compute-read'), api,
    r => r.scenario.lookupPattern === 'individual', r => r.scenario.lookupPattern === 'batch', ['lookupPattern']));
  const loads = loadComparisons(primary, api);
  const sweep = loads.sweep, last = sweep.at(-1), previous = sweep.at(-2);
  const extension = ['native-empty', 'native-compute', 'native-compute-read', 'native-compute-write'].map(mode =>
    best(matched(low.filter(r => r.scenario.hook), api, modeIs(mode), modeIs(mode.replace('native-', 'wasm-'))))).filter(Boolean);
  const pointWork = extension.filter(r => r.context.scenario.mode !== 'wasm-empty'
    && r.context.scenario.iterations <= 100 && r.context.scenario.callbacks <= 1);
  const pointExamples = constraints.length ? constraints.filter(r => r.context.scenario.hook && r.context.scenario.validationOutcome === 'accepted')
    : extension.filter(r => ['wasm-empty', 'wasm-compute', 'wasm-compute-read'].includes(r.context.scenario.mode)
      && r.context.scenario.iterations <= 100 && r.context.scenario.callbacks <= 1);
  const settings = manifest.settings || {}, environment = manifest.environment || {}, dependencies = environment.dependencies || {};
  const routed = environment.network?.mode === 'cf-router';
  const cloudTransport = routed ? 'over CF router HTTPS with tenant HANA' : 'over CF container-to-container ' + (environment.network?.tls ? 'HTTPS' : 'HTTP') + ' with tenant HANA';
  const blocks = ['# CDS-Oyster performance results',
    'CDS-Oyster provides the isolated WebAssembly (WASM) runtime required for business logic from untrusted sources in SAP Cloud Application Programming Model (CAP). This report compares response time and throughput for equivalent native JavaScript and Oyster handlers. Native execution is the measurement reference. Untrusted logic runs in Oyster. A handler is custom code invoked for a data request or service action.',
    '**Blue: native. Orange: Oyster. Gray: no-handler controls.** Vertical bars show absolute measurements. Lower latency means shorter response time. Higher throughput means more requests completed per second. p95 is the response time within which 95% of successful requests completed. Throughput is successful requests per second.',
    '## Application-level impact'];
  if (cloud && settings.pilot) blocks.splice(1, 0, '**Rate-limited setup pilot: configured cap of 3 workload requests/s.** These measurements verify authenticated execution and evidence collection at the configured rate cap. Full concurrency and capacity conclusions require the complete closed-loop protocol.');
  if (cloud && routed) blocks.splice(1, 0, 'Requests travel from the CF runner through the CF router over HTTPS to the provider. End-to-end measurements include TLS and CF router costs; native and Oyster pairs share this path. These measurements do not isolate handler costs at microsecond precision.');
  const whole = primary.filter(r => finite(r.wholeScanElapsedSeconds));
  const wholePairs = matched(whole, api, modeIs('native-compute'), modeIs('wasm-compute'));
  if (pointExamples.length) {
    const labels = pointExamples.flatMap(r => [modeLabel(r.pairs[0][0].scenario), modeLabel(r.context.scenario)]);
    const values = pointExamples.flatMap(r => [r.before, r.after]);
    blocks.push(chart('Predefined extension point: request time', 'Mean request time (ms)', labels, values),
      table(['Extension-point work', 'Native ms', 'Oyster ms', 'Extra ms'], pointExamples.map(r => [oysterHandler(r.context.scenario, modeLabel(r.context.scenario).replace('Oyster ', '')), number(r.before), number(r.after), signed(r.delta)])),
      'Small, bounded extension points keep the isolation premium predictable. Reusing data already held by the application avoids additional database round trips.',
      oysterSources(pointExamples.map(r => r.context.scenario)));
  } else if (representative) {
    const group = groups(ordinary).find(group => group.includes(representative.context));
    const controlModes = ['cap-baseline', 'oyster-idle', 'native-empty', 'wasm-empty'];
    const controls = overhead && group ? tuples(group, controlModes.map(modeIs)) : [];
    const labels = controls.length ? controlModes.map(mode => modes[mode])
      : [modes[representative.pairs[0][0].scenario.mode], modes[representative.pairs[0][1].scenario.mode]];
    const values = controls.length ? controlModes.map((_, i) => summarize(controls.map(pair => pair[i].stats.meanMs)).mean)
      : [representative.before, representative.after];
    blocks.push(chart(operation(representative.context.scenario) + (overhead ? ': empty-handler overhead' : ': equivalent handler work'), 'Mean request time (ms)', labels, values),
      'For ' + oysterHandler(representative.context.scenario) + ', the Oyster-minus-native difference was **' + effect(representative) + '**. This difference includes the complete request path. ' + confidence(representative) + '.');
  } else blocks.push(invalid ? 'The recorded validation failed, so this run cannot establish Oyster overhead.' : 'This run has no valid matched comparison for Oyster overhead.');
  if (primary.some(r => r.scenario.validationOutcome)) {
    blocks.push('### Business constraint: accepted and rejected requests',
      'Ordinary business constraints need little arithmetic. Their cost mainly comes from invoking the isolated handler and, when needed, retrieving additional data. These handlers check quantity × unitPrice against a fixed or queried limit.',
      'Rejection is a normal business outcome and needs its own latency budget. Expected business rejections remain successful outcomes of this test. Accepted and rejected requests are compared separately, with persistence checks confirming the decision.');
    if (constraints.length) {
      blocks.push(table(['Workload', 'Decision', 'Native ms', 'Oyster ms', 'Extra ms'], constraints.map(r =>
        [oysterHandler(r.context.scenario, operation(r.context.scenario) + (r.context.scenario.hook ? ' through extension point' : '') + (r.context.scenario.mode.endsWith('-read') ? ' with lookup' : '')), r.context.scenario.validationOutcome, number(r.before), number(r.after), signed(r.delta)])));
      for (const outcome of ['accepted', 'rejected']) for (const kind of ['validate', 'validate-read']) {
        const row = best(constraints.filter(r => r.context.scenario.validationOutcome === outcome && r.context.scenario.mode === 'wasm-' + kind));
        if (row) blocks.push(chart(operation(row.context.scenario) + (row.context.scenario.hook ? ' extension point' : '') + ': ' + outcome + ' constraint' + (kind.endsWith('-read') ? ' with lookup' : ''), 'Mean request time (ms)',
          ['Native', 'Oyster'], [row.before, row.after]), oysterSources([row.context.scenario]));
      }
      blocks.push('The added milliseconds describe these actual constraint handlers. Use accepted-request costs for normal request budgets and rejected-request costs when estimating rejected traffic. ' + confidence(constraints[0]) + '.');
    } else blocks.push('No eligible native/Oyster constraint pair is available; constraint overhead remains unmeasured.');
  }
  blocks.push(...applicationOverview(ordinary, pointWork, bulk, api, constraints));
  if (settings.repetitions === 1 || settings.suite === 'short') blocks.push('This is one independent short test run. Many requests within each case do not establish variability across test runs. Repeat the test run to determine whether the measured differences persist.');
  if (!manifest.finishedAt || manifest.runSummary?.passed === false) blocks.push('**Run incomplete or completion unrecorded:** only available matching measurements support findings.');

  blocks.push('## 1. What is the typical overhead?');
  const simple = ['create', 'update', 'read', 'action'].map(op => best(lightweight.filter(r => r.context.scenario.operation === op))).filter(Boolean);
  if (simple.length) blocks.push(table(['Workload', 'Native empty ms', 'Oyster empty ms', 'Extra ms', 'Ratio'], simple.map(r =>
    [oysterHandler(r.context.scenario), number(r.before), number(r.after), signed(r.delta), number(r.ratio) + '×'])));
  if (idle.length) blocks.push('Plugin installation and handler invocation are separate costs. Use the no-handler controls to assess the former and the empty-handler controls to budget the latter.');
  blocks.push('An empty handler measures the recurring cost of invoking Oyster without business calculation or auxiliary queries. It still crosses the sandbox boundary and carries request context. READ handlers also carry returned rows. Budget this starting cost for the data each extension receives.',
    'Budget the added milliseconds against the application’s response-time target. Ratios alone exaggerate the impact when the native reference is very fast.');
  blocks.push('## 2. How does overhead change across scenarios?', 'The following comparisons add calculation, auxiliary database queries and invocation through a predefined extension point. Native and Oyster perform the same work in each comparison.');
  const cpu = best(calculation.filter(r => r.context.scenario.operation === 'action'));
  if (cpu) blocks.push(table(['Synthetic arithmetic workload', 'Native ms', 'Oyster ms', 'Extra ms'], [[oysterHandler(cpu.context.scenario, 'Calculation action'), number(cpu.before), number(cpu.after), signed(cpu.delta)]]), 'Repeated arithmetic amplifies the execution cost. Treat these as stress cases when assessing ordinary business constraints.');
  if (io.length) blocks.push(table(['Auxiliary query workload', 'Native ms', 'Oyster ms', 'Extra ms'], ['read', 'write'].map(kind => best(io.filter(r => r.context.scenario.mode.endsWith(kind)))).filter(Boolean).map(r =>
    [oysterHandler(r.context.scenario, operation(r.context.scenario) + ': CQL ' + (r.context.scenario.mode.endsWith('read') ? 'read' : 'update')), number(r.before), number(r.after), signed(r.delta)])));
  blocks.push('All request-time differences include dispatch, handler work, query handling, response processing and transaction completion. They measure the overhead of the complete Oyster execution path.');

  const workloadRows = ['create', 'update', 'read'].map(op => best(calculation.filter(r => r.context.scenario.operation === op && (op !== 'read' || r.context.scenario.rows <= 10)))).filter(Boolean);
  if (workloadRows.length) blocks.push(table(['Small calculation workload', 'Native ms', 'Oyster ms', 'Extra ms'], workloadRows.map(r =>
    [oysterHandler(r.context.scenario), number(r.before), number(r.after), signed(r.delta)])));
  const intensities = calculation.filter(r => r.context.scenario.operation === 'action' && !r.context.scenario.hook);
  if (new Set(intensities.map(r => r.context.scenario.iterations)).size > 1) blocks.push(table(['Calculation iterations', 'Native ms', 'Oyster ms', 'Extra ms', 'Ratio'], intensities.sort((a, b) => a.context.scenario.iterations - b.context.scenario.iterations).map(r =>
    [oysterHandler(r.context.scenario, count(r.context.scenario.iterations)), number(r.before), number(r.after), signed(r.delta), number(r.ratio) + '×'])));
  if (extension.length) blocks.push(table(['Predefined extension-point work', 'Extra Oyster ms'], extension.map(r =>
    [oysterHandler(r.context.scenario, modeLabel(r.pairs[0][0].scenario).replace('Native ', '')), signed(r.delta)])),
    'Keep predefined extension points narrow and reuse the caller’s data. Extra service calls and queries add work to the same request budget.');

  blocks.push('## 3. Which patterns increase overhead?', 'These comparisons examine result volume, repeated database callbacks and increasing concurrent demand.', '### Repeated database callbacks', 'Each database callback requires query validation, CAP dispatch and data exchange. Comparing individual lookups with one query for the same records tests whether reducing these repeated steps lowers request time.');
  if (batching) {
    const group = groups(low, { omit: ['lookupPattern'] }).find(group => group.includes(batching.context));
    const controls = group ? tuples(group, [
      r => r.scenario.mode === 'native-compute-read' && r.scenario.lookupPattern === 'individual',
      r => r.scenario.mode === 'native-compute-read' && r.scenario.lookupPattern === 'batch',
      r => r.scenario.mode === 'wasm-compute-read' && r.scenario.lookupPattern === 'individual',
      r => r.scenario.mode === 'wasm-compute-read' && r.scenario.lookupPattern === 'batch',
    ]) : [];
    const labels = controls.length ? ['Native individual lookups', 'Native batched lookup', 'Oyster individual lookups', 'Oyster batched lookup']
      : ['Oyster individual lookups', 'Oyster batched lookup'];
    const values = controls.length ? [0, 1, 2, 3].map(i => summarize(controls.map(pair => pair[i].stats.meanMs)).mean) : [batching.before, batching.after];
    blocks.push(chart('Equivalent lookup enrichment inside Oyster', 'Mean request time (ms)', labels, values),
    table(['Equivalent lookup work', 'Oyster ms'], [[oysterHandler({ ...batching.context.scenario, lookupPattern: 'individual' }, 'Individual queries'), number(batching.before)], [oysterHandler(batching.context.scenario, 'One batch'), number(batching.after)]]),
    'The same ' + count(batching.context.scenario.rows) + ' distinct keys, columns, arithmetic and scalar result are preserved. ' + signed(batching.delta) + ' ms (' + signed(batching.percent) + '%) is the matched difference.',
    'The handlers reduce the query count from ' + count(batching.context.scenario.rows) + ' query callbacks to one for equivalent work. ' + (batching.delta < 0 ? 'Batching reduced time in this comparison. Allowing an extension to fetch the required records in one query reduces callbacks in this workload.' : 'Batching did not reduce time in this comparison. Repeat the comparison and inspect query and payload costs to assess this result.'));
  } else blocks.push('Not measured: matched individual-versus-batch lookup runs are missing. Measuring ten indexed lookups against one query for the same ten keys and returned result would quantify the effect of batching. This test run provides no such estimate.');
  blocks.push('### What does an additional CQL callback cost?',
    'CQL is CAP’s query language. A CQL callback asks CAP to execute an Oyster query and return its result. The 1-versus-10 action comparison keeps calculation and lookup shape fixed and adds nine sequential statements within one invocation.');
  for (const row of fanout) blocks.push(chart('Action: 1 versus 10 sequential CQL ' + (row.io === 'read' ? 'reads' : 'updates'), 'Mean request time (ms)',
    ['Native: 1 query', 'Native: 10 queries', 'Oyster: 1 callback', 'Oyster: 10 callbacks'], row.times), oysterSources([{ ...row.context.scenario, mode: 'wasm-compute-' + row.io }]));
  if (fanout.length) blocks.push(table(['Query work', 'Native ms per added query', 'Oyster ms per added callback', 'Extra Oyster ms per callback'],
    fanout.map(r => [oysterHandler({ ...r.context.scenario, mode: 'wasm-compute-' + r.io }, 'CQL ' + (r.io === 'read' ? 'read' : 'update')), number(r.native.mean), number(r.oyster.mean), signed(r.overhead.mean)])));
  else blocks.push('Not measured: matched 1-query and 10-query native/Oyster action runs are missing.');
  blocks.push('Increment per statement = (10-statement time minus 1-statement time) / 9. Extra Oyster cost subtracts the native increment. This estimates the average cost of the **nine additional queries**, including database work and data transfer. It does not establish a constant internal callback timer.');
  blocks.push('### Large result sets and loops',
    'Large results combine more row handling, more data transfer and potentially more calculation. Total stored table size and rows processed by an extension are different quantities. A ten-row indexed page can stay small even when its table contains one million rows.');
  if (wholePairs.length) {
    const point = wholePairs[0], total = pairedStats(point.pairs, r => r.wholeScanElapsedSeconds, summarize);
    blocks.push(chart('Processing the whole million-row table', 'Total time (seconds)', ['Native', 'Oyster'], [total.before, total.after]),
      oysterHandler(point.context.scenario, 'Whole-dataset processing') + ' added **' + signed(total.delta) + ' seconds** across ' + total.n + ' paired runs. These are total elapsed seconds for all bounded action calls, rather than per-call milliseconds.');
  }
  for (const row of [bulk, scan].filter(Boolean)) {
    const showControls = row === bulk && bulkControls.length === row.n;
    const labels = showControls ? ['Native empty handler', 'Oyster empty handler', 'Native calculation', 'Oyster calculation'] : ['Native', 'Oyster'];
    const values = showControls ? [0, 1, 2, 3].map(i => summarize(bulkControls.map(pair => pair[i].stats.meanMs)).mean) : [row.before, row.after];
    blocks.push(chart(operation(row.context.scenario), 'Mean request time (ms)', labels, values),
      table(['Large-result work', 'Native ms', 'Oyster ms', 'Extra ms'], showControls
        ? [['Empty READ handler', number(values[0]), number(values[1]), signed(summarize(bulkControls.map(p => p[1].stats.meanMs - p[0].stats.meanMs)).mean)],
          ['READ with per-row arithmetic', number(values[2]), number(values[3]), signed(row.delta)]]
        : [[oysterHandler(row.context.scenario), number(row.before), number(row.after), signed(row.delta)]]),
      oysterSources(showControls ? [{ ...row.context.scenario, mode: 'wasm-empty' }, row.context.scenario] : [row.context.scenario]));
    if (row === bulk && showControls) {
      const emptyDelta = summarize(bulkControls.map(p => p[1].stats.meanMs - p[0].stats.meanMs)).mean;
      blocks.push('Transferring and handling ' + count(row.context.scenario.rows) + ' rows through an ' + oysterHandler({ ...row.context.scenario, mode: 'wasm-empty' }, 'empty Oyster handler') + ' costs about ' + number(Math.round(emptyDelta)) + ' ms extra in this run. Per-row arithmetic adds further overhead. Bound both the result size and the work per row.');
    } else if (row === bulk) blocks.push('The large-result path is more expensive, but missing empty-handler controls mean this run cannot separate result handling from per-row arithmetic.');
    else blocks.push('Paging bounds each invocation’s payload, but a scan still processes the complete dataset. Use bounded pages and a separate latency budget for bulk work.');
  }
  if (!bulk && !scan) blocks.push('Not measured: matching READ/scan result-size comparisons are missing.');

  blocks.push('### Concurrent load and capacity');
  if (sweep.length) {
    const subject = operation(sweep[0].context.scenario) + ': ' + modeLabel({ ...sweep[0].context.scenario, mode: 'wasm-' + sweep[0].suffix }).replace('Oyster ', '');
    blocks.push(oysterSources([{ ...sweep[0].context.scenario, mode: 'wasm-' + sweep[0].suffix }]));
    for (const [metric, title, unit] of [['throughput', 'Throughput', 'Successful requests/s'], ['responseTime', 'Round-trip latency', 'Mean request time (ms)']]) {
      const valid = sweep.filter(r => r[metric].n);
      if (valid.length > 1) blocks.push(chart(subject + ': ' + title, unit,
        valid.flatMap(r => ['Native at ' + loadLabel(r.context), 'Oyster at ' + loadLabel(r.context)]), valid.flatMap(r => [r[metric].before, r[metric].after])));
    }
    blocks.push(table(['Load', 'Native requests/s', 'Oyster requests/s', 'Native mean ms', 'Oyster mean ms', 'Extra mean ms', 'Native p95 ms', 'Oyster p95 ms', 'Extra p95 ms'], sweep.map(r =>
      [loadLabel(r.context), number(r.throughput.before), number(r.throughput.after), number(r.responseTime.before), number(r.responseTime.after), signed(r.responseTime.delta), number(r.latency.before), number(r.latency.after), signed(r.latency.delta)])));
    const peak = sweep.reduce((a, b) => b.throughput.after > a.throughput.after ? b : a);
    const first = sweep[0];
    if (last.throughput.n && previous?.throughput.n) {
      if (last.throughput.after <= previous.throughput.after * 1.1 && last.throughput.after >= peak.throughput.after * .9) {
        if (peak.throughput.after > first.throughput.after * 1.1) blocks.push('Oyster benefits from concurrent requests and sustains near-peak throughput at ' + loadLabel(last.context) + '.');
        blocks.push('The throughput plateau means that additional clients mainly increase request latency. Limit in-flight work around the throughput knee instead of raising concurrency to chase more capacity.');
      } else if (last.throughput.after < peak.throughput.after * .9) blocks.push('Higher concurrency reduces throughput as well as increasing contention. Restrict in-flight work and investigate the bottleneck before increasing load.');
      else blocks.push('Throughput is still rising at the highest measured load. The capacity knee remains unmeasured. Choose the next load level against the application’s latency budget.');
    }
    blocks.push('The per-request delta shows how Oyster’s added latency changes with load. Use it with the complete round-trip time and throughput to choose a concurrency limit.');
  } else blocks.push('Not measured: validated matching latency/throughput measurements across loads are missing.');
  const failedLoads = results.filter(r => r.phase === 'warm' && !lowLoad(r) && (!eligible(r) || invalid));
  blocks.push('Recorded higher-load failures: ' + failedLoads.length + '. Successful response latency excludes failed or unsuitable runs. ' + (cloud && settings.pilot ? 'These are rate-limited pilot observations with a configured 3 workload requests/s cap ' + cloudTransport + '.' : 'The load generator sends the next request after a response; these are closed-loop concurrency measurements ' + (cloud ? cloudTransport : 'on one machine with local SQLite') + '.') + ' They do not establish independently scheduled arrival-rate capacity or horizontal scaling across servers.');
  if (failedLoads.length) blocks.push(table(['Failed workload', 'Load', 'Successful requests/s', 'Errors', 'Dropped starts'], failedLoads.map(r =>
    [r.scenario.mode.startsWith('wasm-') ? oysterHandler(r.scenario, operation(r.scenario) + ': ' + modes[r.scenario.mode]) : operation(r.scenario) + ': ' + modes[r.scenario.mode], loadLabel(r), number(r.stats?.successfulRps), number(r.stats?.errors), number(r.stats?.droppedIterations)])));
  blocks.push('## 4. How do measured costs relate to Oyster’s runtime work?',
    'During an Oyster invocation, a request crosses an isolation boundary, the handler executes as JavaScript inside WebAssembly, and its result must be reintegrated into CAP. Database callbacks additionally validate service-scoped queries, preserve the CAP request context, execute through the service and return encoded results. The runtime also applies configured resource limits and propagates handler errors back to CAP.',
    'The native reference executes in Node.js. Oyster evaluates the handler JavaScript inside its prebuilt WASM framework. The runtime reuses the framework and supports concurrent execution. These measurements do not identify sandbox pool size or utilization. The measured warm phase covers repeated invocations and CAP integration. Startup, initial framework loading and warmup precede it.');
  if (representative) {
    const fence = String.fromCharCode(96).repeat(3);
    blocks.push([fence + 'mermaid', 'flowchart LR',
      '    CAP[CAP request context] --> Encode[Encode and cross boundary]',
      '    Encode --> Sandbox[Isolated JavaScript in WASM]',
      '    Sandbox --> Validate[Validate and apply result]',
      '    Validate --> Response[CAP completes request]',
      '    Sandbox -->|Optional CQL callback| Query[Query checks and CAP service execution]',
      '    Query -->|Encoded query result| Sandbox', fence].join(NL));
  }
  if (lightweight.length) blocks.push('The recurring premium covers isolation and CAP integration. Keep extension boundaries small, reuse available data, and reduce service round trips before optimizing short arithmetic expressions.');
  else blocks.push('This test run lacks the lightweight controls needed to quantify an invocation increment. The available data do not establish that cost.');
  if (bulk || scan) blocks.push('Large-result and scan measurements cover row handling and calculation as well as invocation. Restricting rows and fields passed to an extension reduces the data it must handle. Bulk processing needs a separate latency budget because the empty-handler increment does not describe that workload.');
  blocks.push('### Application design choices', table(['Application design choice', 'Reason from this benchmark'], [
    ['Define extension points with limits on input and result size.', 'The empty-handler and large-result controls measure the cost of an invocation and the additional work of handling returned rows.'],
    ['Pass data already available to the application and allow bounded queries for additional records.', 'The individual-versus-batch comparison tests the cost of fetching equivalent data with fewer callbacks. The custom logic still runs in Oyster.'],
    ['Measure per-record invocation and whole-dataset processing before exposing those interfaces.', 'Large-result and scan costs are measured. Repeated per-record invocation is a separate workload that this test run does not quantify.'],
    ['Set latency and concurrency budgets for representative extension workloads.', 'Use throughput to identify the capacity knee and added request time to assess its latency cost.'],
  ]), cloud ? 'These measurements describe the tested CAP and Oyster versions ' + cloudTransport + '. They do not establish production application capacity.' : 'These measurements describe the tested CAP and Oyster versions on one host with SQLite. They do not compare alternative isolation runtimes or establish production HANA performance.');

  blocks.push('## Evidence quality and remaining measurements', table(['Question', 'Evidence status'], [
    ['Marginal CQL callback cost', fanout.length ? 'Matched 1-versus-10 query observations are present. Repeat before generalizing the increment.' : 'Not measured: the completed test run lacks matched 1-versus-10 queries.'],
    ['Equivalent lookup batching', batching ? confidence(batching) : 'Not measured: the completed test run lacks the fixed individual/batched lookup pair.'],
    ['Bulk result handling versus added calculation', bulkControls.length ? 'Matching empty and calculation handlers compare the result-handling path with per-row arithmetic. Internal components are not individually timed.' : 'Not measured: matching large-result empty-handler controls are missing.'],
    ['Independent variability', settings.repetitions === 1 ? 'One independent repetition. Variability across test runs is not measured.' : count(settings.repetitions) + ' repetitions configured. Detailed results list actual matched repetition counts.'],
    ['Other workloads and horizontal scaling', 'Heavy-load conclusions apply to the named workloads. Multi-server scaling is not measured.'],
  ]));
  blocks.push('## Run setup and reproduction', table(['Recorded setting', 'Value'], [
    ['Run', manifest.id || 'not recorded'], cloud ? ['CF foundation / region', [environment.foundation, environment.region].map(v => v || 'not recorded').join(' / ')] : ['Hardware / OS', [environment.cpus?.[0]?.model, environment.platform, environment.arch].filter(Boolean).join(' / ') || 'not recorded'],
    ['Node / CAP / Oyster / ' + (cloud ? 'HANA' : 'SQLite') + ' adapter', [environment.node, dependencies['@sap/cds'], dependencies['@sap/cds-oyster'], dependencies[cloud ? '@cap-js/hana' : '@cap-js/sqlite']].map(v => v || 'not recorded').join(' / ')],
    ...(cloud ? [['Tenant', environment.tenant || 'not recorded'], ['Provider / runner limits', JSON.stringify({ provider: environment.provider?.memoryLimit, runner: environment.runner })], ['Network / HANA diagnostics', JSON.stringify({ network: environment.network, hana: environment.hanaDiagnostics })]] : []),
    ['Protocol / repetitions', (cloud && settings.pilot ? 'rate-limited pilot, 3 workload requests/s' : settings.suite || 'not recorded') + ' / ' + count(settings.repetitions)],
    ['Warmup / measured seconds per case', number(settings.warmup ?? settings.warmupSeconds) + ' / ' + number(settings.duration ?? settings.measureSeconds)],
    ['Validation', manifest.runSummary?.passed === true ? 'Passed' : manifest.runSummary?.passed === false ? 'Failed or incomplete' : 'Completion not recorded'],
  ]),
    cloud ? 'One Oyster-enabled provider serves native, no-handler and active extension cases in the subscribed tenant. Independent repetition boundaries restore retained CSV identities through the tenant administration API while preserving evidence and the extension. Cached tenant OAuth, source hashing, upload and warmup are outside measurement. Provider and generator run in separate CF containers.' : 'Both app copies use the same model and retained CSVs. The CDS CLI deploys SQLite while CAP is stopped. Fixed projections and stored handlers are reused across cases; writes rotate seeded rows and allocate distinct keys. Native and Oyster handlers share the app with Oyster installed; the plain CAP control omits the plugin. Server startup and warmup are outside measured request time.',
    cloud ? 'Execute node task.js --suite short or --suite long as a CF task in the packaged runner app. Export committed tenant evidence before deleting the tenant. Results retain measurement order; the manifest records source identities and authentication-renewal times.' : 'Run npm install and npm run benchmark for short, or npm run benchmark:long for repeated/larger workloads. The [README](../../README.md) gives complete operator instructions. The runner starts and stops CAP and the load generator.',
    manifest.reporting?.compact
      ? '[Detailed results](details.md) retain the full named use-case chart catalog, comparisons, resource metrics, correctness checks and failures. [Results JSON](results.json), [CSV](results.csv) and [manifest](manifest.json) retain aggregate observations and source hashes. Failed cases retain diagnostic files. Report regeneration does not run new measurements.'
      : '[Detailed results](details.md) contain the full named use-case chart catalog, every matched comparison, resource metric, validation check and failure. [Results JSON](results.json), [CSV](results.csv), [manifest](manifest.json), raw/ and logs/ retain the evidence. Report regeneration does not run new measurements.');
  return blocks.filter(Boolean).join(NL + NL) + NL;
}

function buildUseCaseCatalog(manifest, results, api) {
  const primary = api.validationIssues(manifest.validation).length ? [] : results;
  return ['## Named use-case comparisons', '**Blue: native. Orange: Oyster. Gray: no-handler controls.** These vertical charts retain the individual READ, INSERT, UPDATE, action and extension-point comparisons.',
    ...useCaseCharts(primary, api)].join(NL + NL);
}

module.exports = { oysterHandler, oysterSources, buildHumanReport, buildUseCaseCatalog };
