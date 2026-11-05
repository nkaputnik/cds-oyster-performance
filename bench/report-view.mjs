import { endpoint } from './requests.mjs';

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
};
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
export function oysterHandler(s, label = operation(s)) {
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
  return '[' + safe(label) + '](../../srv/' + service + '/' + file + '.js)';
}

export function oysterSources(scenarios) {
  const links = [...new Set(scenarios.filter(s => s?.mode?.startsWith('wasm-')).map(s => oysterHandler(s, modes[s.mode] || s.mode)))];
  return links.length ? 'Oyster handlers: ' + links.join(', ') + '.' : '';
}

function description(s, question) {
  const op = String(s.operation).toLowerCase();
  let text = op === 'create' ? 'Inserts one row.' : op === 'update' ? 'Updates one existing row.'
    : op === 'read' ? 'Reads ' + count(s.rows) + ' rows from the ' + (s.table === 'LargeRows' ? 'million-row' : '1,000-row') + ' table.'
    : op === 'scan' ? 'Reads pages of ' + count(s.pageSize) + ' rows and calculates a checksum for each row.'
    : 'Calls an action and waits for it to finish.';
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
  if (op !== 'scan') text += ' The same calculation runs ' + count(s.iterations) + ' iterations ' + (op === 'read' ? 'for every returned row.' : 'per request.');
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
        ? [['native-compute-read', 'wasm-compute-read'], ['native-compute-write', 'wasm-compute-write']]
        : [['cap-baseline', 'oyster-idle'], ['native-empty', 'wasm-empty'], ['native-compute', 'wasm-compute']];
      const labels = [], values = [], differences = [];
      for (const [base, target] of definitions) {
        const pairs = tuples(group, [r => r.scenario.mode === base, r => r.scenario.mode === target]);
        if (!pairs.length) continue;
        for (const [i, mode] of [base, target].entries()) {
          const value = summarize(pairs.map(pair => pair[i].stats.meanMs)).mean;
          labels.push(modes[mode] + ' (' + number(value) + ' ms)'); values.push(value);
        }
        const diff = summarize(pairs.map(([a, b]) => b.stats.meanMs - a.stats.meanMs)).mean;
        const name = base === 'cap-baseline' ? 'enabling Oyster' : base === 'native-empty' ? 'empty handler'
          : withCql ? (base.endsWith('read') ? 'CQL read' : 'CQL update') : 'calculation';
        differences.push(oysterHandler({ ...s, mode: target }, name) + ': **' + signed(diff) + ' ms**');
      }
      if (!values.length) continue;
      const title = subject + (s.operation === 'scan' ? ' with paged queries' : withCql ? ' with database queries' : ' without callbacks');
      blocks.push('### ' + title, chart(title, 'Mean request time (ms)', labels, values));
      const work = s.operation === 'scan' ? 'Reads pages of ' + count(s.pageSize) + ' rows and performs ' + count(s.iterations) + ' calculation iterations per row. Native queries run through the service; Oyster uses one callback per page.'
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
    const cpu = pairedStats(pairs, r => r.resources?.cpuPercent, api.summarize);
    const cost = pairedStats(pairs, r => finite(r.resources?.cpuPercent) && r.stats?.successfulRps > 0
      ? r.resources.cpuPercent * 10 / r.stats.successfulRps : null, api.summarize);
    return { context, suffix, pairs, latency: stats('p95Ms'), throughput: stats('successfulRps'), cpu, cost };
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

function applicationOverview(ordinary, pointWork, bulk, api) {
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
  if (point) {
    const originalMs = 100;
    blocks.push('**Illustrative request:** a request taking 100 ms with native handlers, including one ' + oysterHandler(point.context.scenario, modes[point.context.scenario.mode].replace('Oyster ', '')) + ' extension-point call, would take about **' + number(originalMs + point.delta) + ' ms (' + signed(point.delta / originalMs * 100) + '%)** with that call running in Oyster, if the measured increment carries over. The 100 ms baseline is assumed.');
  }
  blocks.push('These are low-load SQLite measurements of individual handlers. A complete business application, multiple extension calls in one request, and registration and startup costs were not measured. Throughput and CPU demand under concurrent load are analyzed below.');
  return blocks;
}

export function buildHumanReport(manifest, results, api) {
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
  const lightweight = empty.filter(row => ['create', 'update', 'read', 'action'].includes(row.context.scenario.operation)
    && (row.context.scenario.operation !== 'read' || row.context.scenario.rows <= 10));
  const overhead = best(lightweight);
  const bulk = calculation.filter(row => row.context.scenario.operation === 'read').sort((a, b) => b.context.scenario.rows - a.context.scenario.rows)[0];
  const scan = calculation.filter(row => row.context.scenario.operation === 'scan').sort((a, b) => b.context.scenario.scanRows - a.context.scenario.scanRows)[0];
  const bulkGroup = bulk && groups(ordinary).find(group => group.includes(bulk.context));
  const bulkControls = bulkGroup ? tuples(bulkGroup, ['native-empty', 'wasm-empty', 'native-compute', 'wasm-compute'].map(modeIs)) : [];
  const io = ['read', 'write'].flatMap(kind => pairsFor('native-compute-' + kind, 'wasm-compute-' + kind));
  const representative = overhead || best(calculation) || best(io);
  const fanout = api.fanoutEvidence(primary);
  const batching = best(matched(low.filter(r => r.scenario.mode === 'wasm-compute-read'), api,
    r => r.scenario.lookupPattern === 'individual', r => r.scenario.lookupPattern === 'batch', ['lookupPattern']));
  const loads = loadComparisons(primary, api);
  const sweep = loads.sweep, last = sweep.at(-1), previous = sweep.at(-2);
  const extension = ['native-empty', 'native-compute', 'native-compute-read', 'native-compute-write'].map(mode =>
    best(matched(low.filter(r => r.scenario.hook), api, modeIs(mode), modeIs(mode.replace('native-', 'wasm-'))))).filter(Boolean);
  const pointWork = extension.filter(r => r.context.scenario.mode !== 'wasm-empty'
    && r.context.scenario.iterations <= 100 && r.context.scenario.callbacks <= 1);
  const pointExamples = extension.filter(r => ['wasm-empty', 'wasm-compute', 'wasm-compute-read'].includes(r.context.scenario.mode)
    && r.context.scenario.iterations <= 100 && r.context.scenario.callbacks <= 1);
  const settings = manifest.settings || {}, environment = manifest.environment || {}, dependencies = environment.dependencies || {};
  const blocks = ['# CDS-Oyster performance results',
    'CDS-Oyster provides the isolated WebAssembly (WASM) runtime required for business logic from untrusted sources in SAP Cloud Application Programming Model (CAP). This report compares response time, throughput and server CPU demand for equivalent native JavaScript and Oyster handlers. Native execution is the measurement reference. Untrusted logic runs in Oyster. A handler is custom code invoked for a data request or service action.',
    '**Blue: native. Orange: Oyster. Gray: no-handler controls.** Vertical bars show absolute measurements. Lower latency means shorter response time. Higher throughput means more requests completed per second. p95 is the response time within which 95% of successful requests completed. Throughput is successful requests per second.',
    '## Application-level impact'];
  const whole = primary.filter(r => finite(r.wholeScanElapsedSeconds));
  const wholePairs = matched(whole, api, modeIs('native-compute'), modeIs('wasm-compute'));
  if (pointExamples.length) {
    const labels = pointExamples.flatMap(r => [modes[r.pairs[0][0].scenario.mode], modes[r.context.scenario.mode]]);
    const values = pointExamples.flatMap(r => [r.before, r.after]);
    blocks.push(chart('Predefined extension point: request time', 'Mean request time (ms)', labels, values),
      'Each test action invokes one predefined extension point. The bars show mean response time for the complete request. CQL is CAP’s query language. An Oyster CQL callback asks CAP to run a database query and return its result.',
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
  const loadSummary = previous && last && previous.throughput.n && last.throughput.n && previous.latency.n && last.latency.n
    ? 'From ' + loadLabel(previous.context) + ' to ' + loadLabel(last.context) + ', Oyster throughput changed ' + signed((last.throughput.after / previous.throughput.after - 1) * 100)
      + '%; p95 changed from ' + number(previous.latency.after) + ' to ' + number(last.latency.after) + ' ms.' : 'Not measured: matching throughput and p95 across loads are missing.';
  blocks.push(...applicationOverview(ordinary, pointWork, bulk, api));
  if (settings.repetitions === 1 || settings.suite === 'short') blocks.push('This is one independent short test run. Many requests within each case do not establish variability across test runs. Repeat the test run to determine whether the measured differences persist.');
  if (!manifest.finishedAt || manifest.runSummary?.passed === false) blocks.push('**Run incomplete or completion unrecorded:** only available matching measurements support findings.');

  blocks.push('## 1. What is the typical overhead?');
  const simple = ['create', 'update', 'read', 'action'].map(op => best(lightweight.filter(r => r.context.scenario.operation === op))).filter(Boolean);
  if (simple.length) blocks.push(table(['Workload', 'Native empty ms', 'Oyster empty ms', 'Extra ms', 'Ratio', 'Paired runs'], simple.map(r =>
    [oysterHandler(r.context.scenario), number(r.before), number(r.after), signed(r.delta), number(r.ratio) + '×', r.n])));
  if (idle.length) blocks.push('Enabling Oyster without invoking a handler changed the matched request times by ' + number(Math.min(...idle.map(r => r.delta))) + ' to ' + number(Math.max(...idle.map(r => r.delta))) + ' ms across the measured controls. Invocation adds a separate cost; these data do not prove enabling the plugin has zero cost.');
  blocks.push('An empty handler measures the recurring cost of invoking Oyster without business calculation or auxiliary queries. It still crosses the sandbox boundary and carries request context; READ handlers also carry returned rows. This is a workload-dependent starting cost, rather than a constant charge for every extension.',
    'The ratio and the absolute increment answer different questions. A large ratio can result from a small native response time. Compare the added milliseconds with the application’s response-time budget, and assess server CPU demand separately.');
  blocks.push('## 2. How does overhead change across scenarios?', 'The following comparisons add calculation, auxiliary database queries and invocation through a predefined extension point. Native and Oyster perform the same work in each comparison.');
  const cpu = best(calculation.filter(r => r.context.scenario.operation === 'action'));
  if (cpu) blocks.push('The ' + count(cpu.context.scenario.iterations) + '-iteration ' + oysterHandler(cpu.context.scenario, 'scalar calculation action') + ' took ' + number(cpu.before) + ' ms native and ' + number(cpu.after) + ' ms Oyster: ' + effect(cpu) + '. The result applies to this arithmetic workload. Other calculations require their own measurements.');
  if (io.length) blocks.push(table(['Calculation plus auxiliary query', 'Native ms', 'Oyster ms', 'Extra ms'], ['read', 'write'].map(kind => best(io.filter(r => r.context.scenario.mode.endsWith(kind)))).filter(Boolean).map(r =>
    [oysterHandler(r.context.scenario, operation(r.context.scenario) + ': CQL ' + (r.context.scenario.mode.endsWith('read') ? 'read' : 'update')), number(r.before), number(r.after), signed(r.delta)])));
  blocks.push('All request-time differences include dispatch, handler work, query handling, response processing and transaction completion. They measure the overhead of the complete Oyster execution path.');

  const workloadRows = ['create', 'update', 'read'].map(op => best(calculation.filter(r => r.context.scenario.operation === op && (op !== 'read' || r.context.scenario.rows <= 10)))).filter(Boolean);
  if (workloadRows.length) blocks.push(table(['Small calculation workload', 'Native ms', 'Oyster ms', 'Extra ms'], workloadRows.map(r =>
    [oysterHandler(r.context.scenario), number(r.before), number(r.after), signed(r.delta)])));
  const intensities = calculation.filter(r => r.context.scenario.operation === 'action' && !r.context.scenario.hook);
  if (new Set(intensities.map(r => r.context.scenario.iterations)).size > 1) blocks.push(table(['Calculation iterations', 'Native ms', 'Oyster ms', 'Extra ms', 'Ratio'], intensities.sort((a, b) => a.context.scenario.iterations - b.context.scenario.iterations).map(r =>
    [oysterHandler(r.context.scenario, count(r.context.scenario.iterations)), number(r.before), number(r.after), signed(r.delta), number(r.ratio) + '×'])));
  if (extension.length) blocks.push(table(['Predefined extension-point work', 'Extra Oyster ms', 'Paired runs'], extension.map(r =>
    [oysterHandler(r.context.scenario, modes[r.pairs[0][0].scenario.mode].replace('Native ', '')), signed(r.delta), r.n])),
    'A predefined extension point is an action the application declares for custom logic. These comparisons include the application calling a second CAP service to invoke that logic. They measure the complete routed path. They do not isolate routing cost or show that this route is faster than a direct handler.');

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
    'The same ' + count(batching.context.scenario.rows) + ' distinct keys, columns, arithmetic and scalar result took ' + number(batching.before) + ' ms with ' + oysterHandler({ ...batching.context.scenario, lookupPattern: 'individual' }, 'individual queries') + ' and ' + number(batching.after) + ' ms in ' + oysterHandler(batching.context.scenario, 'one batch') + ': ' + signed(batching.delta) + ' ms (' + signed(batching.percent) + '%). ' + confidence(batching) + '.',
    'The handlers reduce the query count from ' + count(batching.context.scenario.rows) + ' query callbacks to one for equivalent work. ' + (batching.delta < 0 ? 'Batching reduced time in this comparison. Allowing an extension to fetch the required records in one query reduces callbacks in this workload.' : 'Batching did not reduce time in this comparison. Repeat the comparison and inspect query and payload costs to assess this result.'));
  } else blocks.push('Not measured: matched individual-versus-batch lookup runs are missing. Measuring ten indexed lookups against one query for the same ten keys and checksum would quantify the effect of batching. This test run provides no such estimate.');
  blocks.push('### What does an additional CQL callback cost?',
    'CQL is CAP’s query language. A CQL callback asks CAP to execute an Oyster query and return its result. The 1-versus-10 action comparison keeps calculation and lookup shape fixed and adds nine sequential statements within one invocation.');
  for (const row of fanout) blocks.push(chart('Action: 1 versus 10 sequential CQL ' + (row.io === 'read' ? 'reads' : 'updates'), 'Mean request time (ms)',
    ['Native: 1 query', 'Native: 10 queries', 'Oyster: 1 callback', 'Oyster: 10 callbacks'], row.times), oysterSources([{ ...row.context.scenario, mode: 'wasm-compute-' + row.io }]));
  if (fanout.length) blocks.push(table(['Query work', 'Native ms per added query', 'Oyster ms per added callback', 'Extra Oyster ms per callback', 'Paired runs'],
    fanout.map(r => [oysterHandler({ ...r.context.scenario, mode: 'wasm-compute-' + r.io }, 'CQL ' + (r.io === 'read' ? 'read' : 'update')), number(r.native.mean), number(r.oyster.mean), signed(r.overhead.mean), r.n])));
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
      oysterHandler(row.context.scenario) + ' added **' + effect(row) + '** with ' + count(row.context.scenario.iterations) + ' calculation iterations per row. ' + confidence(row) + '.',
      oysterSources(showControls ? [{ ...row.context.scenario, mode: 'wasm-empty' }, row.context.scenario] : [row.context.scenario]),
      'A limit on rows passed to a READ handler or action bounds the amount of work within that call. Paging limits each payload, but the complete scan still processes every row.');
  }
  if (bulk) {
    if (bulkControls.length) {
      const oyster = summarize(bulkControls.map(p => p[3].stats.meanMs - p[1].stats.meanMs));
      const native = summarize(bulkControls.map(p => p[2].stats.meanMs - p[0].stats.meanMs));
      const emptyDelta = summarize(bulkControls.map(p => p[1].stats.meanMs - p[0].stats.meanMs)).mean;
      const calculationDelta = summarize(bulkControls.map(p => (p[3].stats.meanMs - p[1].stats.meanMs) - (p[2].stats.meanMs - p[0].stats.meanMs))).mean;
      blocks.push('With matching large-result empty handlers, adding ' + oysterHandler(bulk.context.scenario, 'calculation') + ' changed Oyster time by ' + signed(oyster.mean) + ' ms and native time by ' + signed(native.mean) + ' ms. Matched repetition pairs: ' + bulkControls.length + '.',
        'Passing and handling ' + count(bulk.context.scenario.rows) + ' rows through an ' + oysterHandler({ ...bulk.context.scenario, mode: 'wasm-empty' }, 'empty Oyster handler') + ' already adds ' + signed(emptyDelta) + ' ms versus native. The ' + oysterHandler(bulk.context.scenario, 'arithmetic and checksum changes') + ' add another ' + signed(calculationDelta) + ' ms beyond the native calculation increment. Result volume and calculation per row both contribute to the measured increment. These controls compare complete paths. They do not time serialization or interpreter components separately.');
    } else blocks.push('**Not measured:** matching large-result empty-handler controls are missing. The bulk-path penalty is observed, but this test run cannot separate result handling from the added calculation.');
  }
  if (!bulk && !scan) blocks.push('Not measured: matching READ/scan result-size comparisons are missing.');

  blocks.push('### Concurrent load and capacity');
  if (sweep.length) {
    const subject = operation(sweep[0].context.scenario) + ': ' + modes['wasm-' + sweep[0].suffix].replace('Oyster ', '');
    blocks.push(oysterSources([{ ...sweep[0].context.scenario, mode: 'wasm-' + sweep[0].suffix }]));
    for (const [metric, title, unit] of [['throughput', 'Throughput', 'Successful requests/s'], ['latency', 'Tail latency', 'Request p95 (ms)']]) {
      const valid = sweep.filter(r => r[metric].n);
      if (valid.length > 1) blocks.push(chart(subject + ': ' + title, unit,
        valid.flatMap(r => ['Native at ' + loadLabel(r.context), 'Oyster at ' + loadLabel(r.context)]), valid.flatMap(r => [r[metric].before, r[metric].after])));
    }
    blocks.push(table(['Load', 'Native requests/s', 'Oyster requests/s', 'Native p95 ms', 'Oyster p95 ms', 'Native CPU cores', 'Oyster CPU cores'], sweep.map(r =>
      [loadLabel(r.context), number(r.throughput.before), number(r.throughput.after), number(r.latency.before), number(r.latency.after), number(finite(r.cpu.before) ? r.cpu.before / 100 : null), number(finite(r.cpu.after) ? r.cpu.after / 100 : null)])),
      oysterHandler({ ...sweep[0].context.scenario, mode: 'wasm-' + sweep[0].suffix }, subject) + '. ' + loadSummary + ' Comparisons use the same independent repetitions at every load.');
    if (previous && last && previous.throughput.n && last.throughput.n && previous.latency.n && last.latency.n) blocks.push(
      (last.throughput.after <= previous.throughput.after && last.latency.after > previous.latency.after
        ? 'Additional concurrency did not increase observed Oyster throughput and increased tail latency in this range. The measurements show a throughput plateau in this range but do not identify the limiting resource.'
        : 'Throughput and tail latency changed together. Compare the throughput change with the change in p95 and CPU demand. These points do not establish linear scaling.') +
      ' Capacity planning therefore needs the target workload and response-time limit. Increasing concurrent requests can increase waiting time without increasing completed work.');
    const cost = [...sweep].reverse().find(r => r.cost.n && r.context.load.value > 1);
    if (cost) blocks.push('At ' + loadLabel(cost.context) + ', measured server CPU cost per successful request was ' + number(cost.cost.before) + ' ms native and ' + number(cost.cost.after) + ' ms ' + oysterHandler({ ...cost.context.scenario, mode: 'wasm-' + cost.suffix }, 'Oyster') +
      (finite(cost.cost.ratio) ? ' (' + number(cost.cost.ratio) + '×)' : '') + '. CPU cores equal CPU percent / 100; CPU milliseconds per request equal CPU percent × 10 / successful requests per second. This measures process resource cost, not only handler execution.');
  } else blocks.push('Not measured: validated matching latency/throughput measurements across loads are missing.');
  const failedLoads = results.filter(r => r.phase === 'warm' && !lowLoad(r) && (!eligible(r) || invalid));
  blocks.push('Recorded higher-load failures: ' + failedLoads.length + '. Successful response latency excludes failed or unsuitable runs. The load generator sends the next request after a response; these are closed-loop concurrency measurements on one machine with local SQLite. They do not establish independently scheduled arrival-rate capacity or horizontal scaling across servers.');
  if (failedLoads.length) blocks.push(table(['Failed workload', 'Load', 'Successful requests/s', 'Errors', 'Dropped starts'], failedLoads.map(r =>
    [r.scenario.mode.startsWith('wasm-') ? oysterHandler(r.scenario, operation(r.scenario) + ': ' + modes[r.scenario.mode]) : operation(r.scenario) + ': ' + modes[r.scenario.mode], loadLabel(r), number(r.stats?.successfulRps), number(r.stats?.errors), number(r.stats?.droppedIterations)])));
  blocks.push('## 4. How do measured costs relate to Oyster’s runtime work?',
    'During an Oyster invocation, a request crosses an isolation boundary, the handler executes as JavaScript inside WebAssembly, and its result must be reintegrated into CAP. Database callbacks additionally validate service-scoped queries, preserve the CAP request context, execute through the service and return encoded results. The runtime also applies configured resource limits and propagates handler errors back to CAP.',
    'The native reference executes in Node.js; Oyster evaluates the handler JavaScript inside its WASM framework. The framework is prebuilt and reused. The measured warm phase covers repeated sandbox invocations and CAP integration; startup, initial framework loading and warmup precede it. The benchmark measures the complete path, with no separate timer for each internal component.');
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
  if (lightweight.length) blocks.push('For the lightweight empty-handler workloads, the extra request time is ' + number(Math.min(...lightweight.map(r => r.delta))) + ' to ' + number(Math.max(...lightweight.map(r => r.delta))) + ' ms in this test run. This is the combined increment for the measured isolation and CAP integration path. Whether it fits an application depends on that application’s response-time budget. It does not quantify each internal step or predict the cost of larger inputs and calculations.');
  else blocks.push('This test run lacks the lightweight controls needed to quantify an invocation increment. The available data do not establish that cost.');
  if (bulk || scan) blocks.push('Large-result and scan measurements cover row handling and calculation as well as invocation. Restricting rows and fields passed to an extension reduces the data it must handle. Bulk processing needs a separate latency and CPU budget because the empty-handler increment does not describe that workload.');
  const serverCost = [...sweep].reverse().find(r => r.cost.n && r.context.load.value > 1);
  if (serverCost) blocks.push('At ' + loadLabel(serverCost.context) + ', ' + oysterHandler({ ...serverCost.context.scenario, mode: 'wasm-' + serverCost.suffix }, 'Oyster') + ' required ' + number(serverCost.cost.ratio) + '× the native server CPU time per successful request for the named workload. The extra response time at light load therefore does not describe server capacity. Use the measured throughput, p95 and CPU demand together when sizing this workload.');
  blocks.push('### Application design choices', table(['Application design choice', 'Reason from this benchmark'], [
    ['Define extension points with limits on input and result size.', 'The empty-handler and large-result controls measure the cost of an invocation and the additional work of handling returned rows.'],
    ['Pass data already available to the application and allow bounded queries for additional records.', 'The individual-versus-batch comparison tests the cost of fetching equivalent data with fewer callbacks. The custom logic still runs in Oyster.'],
    ['Measure per-record invocation and whole-dataset processing before exposing those interfaces.', 'Large-result and scan costs are measured. Repeated per-record invocation is a separate workload that this test run does not quantify.'],
    ['Set response-time and CPU budgets for representative extension workloads.', 'The load comparison reports latency and CPU demand separately. An empty-handler increment alone cannot establish capacity for another workload.'],
  ]), 'These measurements describe the tested CAP and Oyster versions on one host with SQLite. They do not compare alternative isolation runtimes or establish production HANA performance.');

  blocks.push('## Evidence quality and remaining measurements', table(['Question', 'Evidence status'], [
    ['Marginal CQL callback cost', fanout.length ? 'Matched 1-versus-10 query observations are present. Repeat before generalizing the increment.' : 'Not measured: the completed test run lacks matched 1-versus-10 queries.'],
    ['Equivalent lookup batching', batching ? confidence(batching) : 'Not measured: the completed test run lacks the fixed individual/batched lookup pair.'],
    ['Bulk result handling versus added calculation', bulkControls.length ? 'Matching empty and calculation handlers compare the result-handling path with added arithmetic and checksum work. Internal components are not individually timed.' : 'Not measured: matching large-result empty-handler controls are missing.'],
    ['Independent variability', settings.repetitions === 1 ? 'One independent repetition. Variability across test runs is not measured.' : count(settings.repetitions) + ' repetitions configured; paired run counts show actual available evidence.'],
    ['Other workloads and horizontal scaling', 'Heavy-load conclusions apply to the named workloads. Multi-server scaling is not measured.'],
  ]));
  blocks.push('## Run setup and reproduction', table(['Recorded setting', 'Value'], [
    ['Run', manifest.id || 'not recorded'], ['Hardware / OS', [environment.cpus?.[0]?.model, environment.platform, environment.arch].filter(Boolean).join(' / ') || 'not recorded'],
    ['Node / CAP / Oyster / SQLite adapter', [environment.node, dependencies['@sap/cds'], dependencies['@sap/cds-oyster'], dependencies['@cap-js/sqlite']].map(v => v || 'not recorded').join(' / ')],
    ['Protocol / repetitions', (settings.suite || 'not recorded') + ' / ' + count(settings.repetitions)],
    ['Warmup / measured seconds per case', number(settings.warmup ?? settings.warmupSeconds) + ' / ' + number(settings.duration ?? settings.measureSeconds)],
    ['Validation', manifest.runSummary?.passed === true ? 'Passed' : manifest.runSummary?.passed === false ? 'Failed or incomplete' : 'Completion not recorded'],
  ]),
    'Both app copies use the same model and retained CSVs. The CDS CLI deploys SQLite while CAP is stopped. Fixed projections and stored handlers are reused across cases; writes rotate seeded rows and allocate distinct keys. Native and Oyster handlers share the app with Oyster installed; the plain CAP control omits the plugin. Server startup and warmup are outside measured request time.',
    'Run npm install and npm run benchmark for short, or npm run benchmark:long for repeated/larger workloads. The [README](../../README.md) gives complete operator instructions. The runner starts and stops CAP and the load generator.',
    '[Detailed results](details.md) contain the full named use-case chart catalog, every matched comparison, resource metric, validation check and failure. [Results JSON](results.json), [CSV](results.csv), [manifest](manifest.json), raw/ and logs/ retain the evidence. Report regeneration does not run new measurements.');
  return blocks.filter(Boolean).join(NL + NL) + NL;
}

export function buildUseCaseCatalog(manifest, results, api) {
  const primary = api.validationIssues(manifest.validation).length ? [] : results;
  return ['## Named use-case comparisons', '**Blue: native. Orange: Oyster. Gray: no-handler controls.** These vertical charts retain the individual READ, INSERT, UPDATE, action and extension-point comparisons.',
    ...useCaseCharts(primary, api)].join(NL + NL);
}
