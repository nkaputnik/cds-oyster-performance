const NL = String.fromCharCode(10);
const modes = {
  'cap-baseline': 'Plain CAP', 'oyster-idle': 'Oyster enabled, no handler',
  'native-empty': 'Native empty handler', 'wasm-empty': 'Oyster empty handler',
  'native-compute': 'Native calculation', 'wasm-compute': 'Oyster calculation',
  'native-compute-read': 'Native calculation + CQL read', 'wasm-compute-read': 'Oyster calculation + CQL read',
  'native-compute-write': 'Native calculation + CQL write', 'wasm-compute-write': 'Oyster calculation + CQL write',
};
const questions = {
  'Installed plugin overhead': 'Oyster enabled without a handler',
  'Sandbox path versus native handler': 'empty handler',
  'Execution-location penalty for CPU work': 'calculation without auxiliary CQL',
  'CPU plus auxiliary read path': 'calculation + CQL read',
  'CPU plus auxiliary write path': 'calculation + CQL write',
  'Unimplemented hook routing': 'Calling an unimplemented extension point',
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
  return ['```mermaid', '---', 'config:', '  xyChart:', '    width: 1100', '    height: ' + Math.max(300, labels.length * 32 + 130),
    '    xAxis:', '      labelFontSize: 13', '---', 'xychart-beta horizontal', '    title ' + quoted(title),
    '    x-axis [' + labels.map(quoted).join(', ') + ']', '    y-axis ' + quoted(unit) + ' ' + floor + ' --> ' + ceiling,
    '    ' + kind + ' [' + values.join(', ') + ']', '```'].join(NL);
}

function best(rows) {
  return [...rows].sort((a, b) => Number(a.context.scenario.hook) - Number(b.context.scenario.hook)
    || Number(b.context.scenario.operation === 'action') - Number(a.context.scenario.operation === 'action')
    || Number(a.context.scenario.table === 'LargeRows') - Number(b.context.scenario.table === 'LargeRows')
    || (a.context.scenario.rows ?? 0) - (b.context.scenario.rows ?? 0))[0];
}
function unique(rows, key) {
  const seen = new Set();
  return rows.filter(row => {
    const id = key(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
function loadLabel(result) {
  return count(result.load?.value) + (['rate', 'arrival', 'constant-arrival-rate'].includes(result.load?.kind) ? ' requests/s' : result.load?.value === 1 ? ' concurrent client' : ' concurrent clients');
}

export function buildHumanReport(manifest, results, api) {
  const { groups, metric, eligible, lowLoad, findingEvidence, callbackEvidence, directCallbackEvidence, sweepEvidence, validationIssues, summarize } = api;
  const globalInvalid = validationIssues(manifest.validation).length > 0;
  const transport = results.some(r => r.transport === 'http') ? 'http' : 'service';
  // Retain invalid and duplicate records until repetition uniqueness has been checked.
  const primary = globalInvalid ? [] : results.filter(r => r.transport === transport);
  const findings = findingEvidence(primary).filter(row => row.n && row.context.scenario.scanCoordination !== 'external');
  const callbacks = callbackEvidence(primary).filter(row => row.n);
  const directCallbacks = directCallbackEvidence ? directCallbackEvidence(primary).filter(row => row.n) : [];
  const select = (question, rows = findings, predicate = () => true) => best(rows.filter(row => row.question === question && predicate(row)));
  const label = row => operation(row.context.scenario) + ': ' + (questions[row.question] || row.question)
    + (row.context.scenario.hook ? ' through extension point' : '');
  const delta = row => row ? signed(row.mean) + ' ms (' + row.n + ' paired ' + (row.n === 1 ? 'run' : 'runs') + ')' : 'not measured: validated matching runs are missing';
  const answer = (parts, reason) => parts.some(p => p.row) ? parts.map(p => p.label + (p.row ? ' (' + operation(p.row.context.scenario) + ')' : '') + ': ' + delta(p.row)).join('. ') + '.' : 'Not measured: ' + reason + '.';
  const settings = manifest.settings || {}, warmup = settings.warmup ?? settings.warmupSeconds, duration = settings.duration ?? settings.measureSeconds;
  const exploratory = !['short', 'long'].includes(settings.suite) && (settings.suite === 'smoke' || (finite(warmup) && warmup < 15) || (finite(duration) && duration < 30));
  const blocks = ['# CDS-Oyster performance results',
    'This benchmark measures the cost of custom logic in SAP Cloud Application Programming Model (CAP). A handler is custom code invoked for a data request or service action. It compares JavaScript handlers running in the CAP application process, called **native handlers**, with equivalent handlers running in **Oyster**, an isolated WebAssembly (WASM) sandbox. The database is local SQLite.'];
  const whole = primary.filter(r => finite(r.wholeScanElapsedSeconds));
  if (whole.length) {
    const totals = whole.map(r => ({ ...r, stats: { ...r.stats, totalSeconds: r.wholeScanElapsedSeconds } }));
    const points = groups(totals, { mode: true }).map(group => ({ group, summary: metric(group, 'totalSeconds') })).filter(p => finite(p.summary.mean));
    if (points.length) blocks.push('## Processing the whole million-row table', chart('Whole dataset processing', 'Total time (seconds)',
      points.map(p => modes[p.group[0].scenario.mode]), points.map(p => p.summary.mean)),
      'Each path reads and calculates over the complete dataset through multiple bounded action calls. The chart shows total elapsed seconds for all calls, including page queries and calculation. Individual call timings are in [Detailed results](details.md).');
    const paired = select('Execution-location penalty for CPU work', findingEvidence(whole.map(r => ({ ...r, stats: { ...r.stats, meanMs: r.wholeScanElapsedSeconds * 1000 } }))));
    if (paired) blocks.push('Oyster added **' + signed(paired.mean / 1000) + ' seconds** (' + signed(paired.percent) + '% across ' + paired.n + ' paired runs).');
  }
  const shown = [];
  for (const question of ['Installed plugin overhead', 'Sandbox path versus native handler']) for (const op of ['create', 'update', 'read', 'action']) {
    const row = best(findings.filter(row => row.question === question && row.context.scenario.operation === op));
    if (row) shown.push(row);
  }
  for (const question of ['Execution-location penalty for CPU work', 'CPU plus auxiliary read path', 'CPU plus auxiliary write path'])
    for (const row of findings.filter(row => row.question === question)) if (shown.length < 8 && !shown.includes(row)) shown.push(row);
  if (shown.length || !whole.length) blocks.push('## Oyster overhead');
  if (shown.length) blocks.push(chart('Extra time when using Oyster', 'Additional time per request (ms)', shown.map(label), shown.map(row => row.mean)),
    'Positive bars mean Oyster took longer. Values are differences in **mean request time**, in milliseconds. The no-handler comparison enables Oyster without invoking it. The empty-handler comparison invokes a handler that does nothing in native JavaScript or Oyster. INSERT adds one row, UPDATE changes one row, READ returns the stated number of rows, and an action is a custom service operation.',
    table(['Situation', 'Work performed and comparison', 'Extra time', 'Change', 'Paired runs'], shown.map(row => [label(row), description(row.context.scenario, row.question),
      signed(row.mean) + ' ms', finite(row.percent) ? signed(row.percent) + '%' : 'not measured', row.n])));
  else if (!whole.length) blocks.push(globalInvalid ? 'The recorded validation failed, so this run cannot establish Oyster overhead.' : 'This run has no valid matched comparison for Oyster overhead.');
  const computationRows = findings.filter(row => !row.context.scenario.hook && row.context.scenario.operation !== 'scan' && row.context.scenario.table !== 'LargeRows' &&
    ['Execution-location penalty for CPU work', 'CPU plus auxiliary read path', 'CPU plus auxiliary write path'].includes(row.question)).slice(0, 12);
  if (computationRows.length) blocks.push('## Moving calculation and database work into Oyster',
    chart('Oyster overhead for calculation and CQL', 'Additional request time (ms)', computationRows.map(label), computationRows.map(row => row.mean)),
    '**CQL** is CAP\'s query language. A **CQL callback** lets sandbox code ask the CAP application to run a query and return its result. Each bar compares equivalent native and Oyster handlers. Calculation-only handlers use the same arithmetic loop to produce a checksum, a number checked to confirm equivalent work completed, without extra queries. The CQL variants add a read or update in a separate auxiliary table. INSERT, UPDATE and READ still perform their main database operation in every variant. READ calculation runs for each returned row, with auxiliary queries once per returned batch. The READ-plus-update variant selects an auxiliary row key and then updates that row on both paths.');
  if (settings.suite === 'short') blocks.push('This short run measures each case once. Many requests within a case improve its timing sample, but do not provide independent repeat measurements.');
  if (exploratory) blocks.push('**Exploratory timings:** these short measurement windows describe this run. Stable overhead and capacity require longer, repeated measurements.');
  if (!manifest.finishedAt) blocks.push('**Completion is not recorded.** Available measurements are shown. Remaining comparisons are pending.');
  const low = primary.filter(r => lowLoad(r) && r.scenario.scanCoordination !== 'external');
  const reference = groups(low).filter(group => new Set(group.map(r => r.scenario.mode)).size >= 2)
    .sort((a, b) => new Set(b.map(r => r.scenario.mode)).size - new Set(a.map(r => r.scenario.mode)).size)[0];
  if (reference) {
    const points = groups(reference, { mode: true }).map(group => ({ group, summary: metric(group, 'meanMs') })).filter(p => finite(p.summary.mean));
    if (points.length) blocks.push('For context, absolute request times for ' + operation(reference[0].scenario) + ':',
      table(['Execution path', 'Mean request time (ms)', 'Independent runs'], points.map(p => [modes[p.group[0].scenario.mode], number(p.summary.mean), p.summary.n])));
  }
  const cpu = select('Execution-location penalty for CPU work');
  const nativeCpu = select('Native calculation versus plain CAP') || select('Native CPU handler overhead');
  const nativeRead = select('Native CQL read versus plain CAP') || select('Native auxiliary read increment');
  const nativeWrite = select('Native CQL write versus plain CAP') || select('Native auxiliary write increment');
  const loopRows = findings.filter(row => row.question === 'Execution-location penalty for CPU work' && ['read', 'scan'].includes(row.context.scenario.operation));
  const scan = best(loopRows.filter(row => row.context.scenario.operation === 'scan'));
  const sweeps = sweepEvidence(primary);
  const rowSweep = sweeps.find(item => item.sweep.dimension === 'rows' && item.name === 'meanMs' && item.valid[0].group[0].scenario.mode === 'wasm-compute')
    || sweeps.find(item => ['rows', 'scanRows', 'iterations'].includes(item.sweep.dimension) && item.name === 'meanMs');
  const loadSweep = sweeps.find(item => item.sweep.dimension === 'load' && item.name === 'p95Ms' && item.area === 'stats' && item.valid[0].group[0].scenario.mode.startsWith('wasm-'))
    || sweeps.find(item => item.sweep.dimension === 'load' && item.name === 'p95Ms' && item.area === 'stats');
  const sweepAnswer = item => {
    const first = item.valid[0], last = item.valid.at(-1);
    const dimension = { rows: 'returned rows', scanRows: 'scanned rows', iterations: 'calculation iterations' }[item.sweep.dimension] || item.sweep.dimension;
    return modes[first.group[0].scenario.mode] + ': ' + number(first.stats.mean) + ' to ' + number(last.stats.mean) + ' ms as '
      + (item.sweep.dimension === 'load' ? 'load increases from ' + loadLabel(first.group[0]) + ' to ' + loadLabel(last.group[0])
        : dimension + ' increase from ' + count(item.value(first.group)) + ' to ' + count(item.value(last.group)))
      + ' (' + first.stats.n + '/' + last.stats.n + ' independent runs)';
  };
  const failedLoad = primary.filter(r => r.phase === 'warm' && !lowLoad(r) && !eligible(r));
  blocks.push('## What the results show', table(['Finding', 'What the comparison measures', 'Observed result'], [
    ['Cost of native custom logic', 'Adds calculation and auxiliary queries to an ordinary CAP request. The operation named beside each result is the measured example.',
      answer([{ label: nativeCpu?.question === 'Native CPU handler overhead' ? 'Calculation versus native empty handler' : 'Calculation versus plain CAP', row: nativeCpu },
        { label: nativeRead?.question === 'Native auxiliary read increment' ? 'Additional native query' : 'Calculation + CQL read versus plain CAP', row: nativeRead },
        { label: nativeWrite?.question === 'Native auxiliary write increment' ? 'Additional native update' : 'Calculation + CQL update versus plain CAP', row: nativeWrite }], 'matching native calculation and query controls are missing')],
    ['Cost of moving logic into Oyster', 'Moves equivalent calculation and query work from the application process into the sandbox.',
      answer([{ label: 'Calculation versus native', row: cpu }, { label: 'Calculation + CQL read versus native', row: select('CPU plus auxiliary read path') },
        { label: 'Calculation + CQL update versus native', row: select('CPU plus auxiliary write path') }], 'equivalent native and Oyster runs are missing')],
    ['Cost of enabling and invoking Oyster', 'Separates enabling the plugin without using a handler from invoking an empty sandbox handler.',
      answer([{ label: 'Oyster enabled versus plain CAP', row: select('Installed plugin overhead') }, { label: 'Empty Oyster versus native empty handler', row: select('Sandbox path versus native handler') },
        { label: 'Empty Oyster versus Oyster enabled without a handler', row: select('Total empty sandbox path') }], 'no-handler or empty-handler controls are missing')],
    ['Cost of database callbacks', 'Compares the extra query time in Oyster with the extra query time in native code, after accounting for calculation-only handler time.',
      answer([{ label: 'Extra read callback cost versus ' + (select('Direct database read', directCallbacks) ? 'direct database access' : 'native service access'), row: select('Direct database read', directCallbacks) || select('Auxiliary read', callbacks) },
        { label: 'Extra update callback cost versus ' + (select('Direct database write', directCallbacks) ? 'direct database access' : 'native service access'), row: select('Direct database write', directCallbacks) || select('Auxiliary write', callbacks) }], 'matching calculation-only and query variants are missing')],
    ['Cost of processing larger results', 'Calculates over returned rows or queries and processes pages inside an action.',
      scan || rowSweep || loopRows.length ? (scan ? operation(scan.context.scenario) + ': Oyster versus native ' + delta(scan) + '. ' : '')
        + (rowSweep ? sweepAnswer(rowSweep) + '.' : 'Returned-row scaling is not measured.')
        : 'Not measured: matching READ or scan runs and size comparisons are missing.'],
    ['Behavior under concurrent load', 'Keeps the action workload fixed while increasing simultaneous clients. p95 is the time within which 95% of successful requests finish.',
      loadSweep ? 'Request p95, ' + sweepAnswer(loadSweep) + '. ' + failedLoad.length + ' load runs failed.'
        : 'Not measured: a validated latency comparison across different loads is missing. ' + failedLoad.length + ' load runs failed.'],
  ]));
  blocks.push('Examples in this summary apply to the named operation. The charts and [Detailed results](details.md) cover the other operations. A paired run is an independent repetition in which both compared paths passed validation with the same workload and load.');
  const callbackRows = ['Auxiliary read', 'Auxiliary write'].map(question => select(question, callbacks)).filter(Boolean);
  const dbRows = ['Native service versus database read', 'Native service versus database write'].map(question => select(question)).filter(Boolean);
  blocks.push('## Database access through CQL callbacks',
    'Native code can query a CAP service or query the database directly. Oyster sends its queries back to CAP through callbacks. The table compares the **additional cost of adding the query**, so the cost of merely invoking a handler is accounted for on both paths.');
  if (callbackRows.length || directCallbacks.length || dbRows.length) blocks.push(table(['Comparison', 'Operation', 'Extra time', 'Paired runs'], [
    ...callbackRows.map(row => [row.question === 'Auxiliary read' ? 'Oyster read callback versus native service query' : 'Oyster update callback versus native service query', operation(row.context.scenario), signed(row.mean) + ' ms', row.n]),
    ...directCallbacks.map(row => [row.question.includes('read') ? 'Oyster read callback versus direct database query' : 'Oyster update callback versus direct database query', operation(row.context.scenario), signed(row.mean) + ' ms', row.n]),
    ...dbRows.map(row => [row.question.replace('Native service versus database', 'Native service versus direct database'), operation(row.context.scenario), signed(row.mean) + ' ms', row.n]),
  ]));
  else blocks.push('CQL read: not measured. CQL update: not measured. Calculation-only and calculation-plus-query runs are needed for both execution paths.');
  blocks.push('Extra callback cost = (Oyster with a query minus Oyster calculation-only) minus (native with a query minus native calculation-only). This measures complete request paths, including query handling and data transfer. It is not an isolated internal callback timer.');
  const extension = [['Empty handler', 'Sandbox path versus native handler'], ['Calculation without CQL', 'Execution-location penalty for CPU work'],
    ['Calculation + CQL read', 'CPU plus auxiliary read path'], ['Calculation + CQL update', 'CPU plus auxiliary write path']]
    .map(([name, question]) => [name, select(question, findings, row => row.context.scenario.hook === true)]);
  blocks.push('## Calling predefined extension points',
    'An **extension point** is a predefined service action that the application calls to run custom logic. These tests compare a native implementation with an Oyster implementation reached through the same calling action. This includes the extra service call, rather than attaching logic directly to a data operation.',
    table(['Extension-point work', 'Extra time for Oyster versus native'], extension.map(([name, row]) => [name, delta(row)])),
    'A separate control calls an extension point with no custom implementation and compares it with bypassing that call: ' + delta(select('Unimplemented hook routing')) + '. This estimates the cost of taking the extension-point route itself.');
  blocks.push('## Reading and processing larger results',
    'Table size and result size are different: a READ can return 10 rows from a table containing one million rows. Returned-row tests include calculation and transferring the rows in the response. Scan actions instead read successive pages, calculate a checksum for every row, and return only that checksum.');
  if (rowSweep) {
    const first = rowSweep.valid[0].group[0];
    const subject = rowSweep.sweep.dimension === 'rows' ? 'READ from ' + (first.scenario.table === 'LargeRows' ? 'million-row table' : '1,000-row table') : operation(first.scenario);
    blocks.push(chart(subject + ': scaling with ' + modes[first.scenario.mode], 'Mean request time (ms)',
      rowSweep.valid.map(p => count(rowSweep.value(p.group)) + (rowSweep.sweep.dimension === 'iterations' ? ' iterations' : ' rows')), rowSweep.valid.map(p => p.stats.mean), 'line'));
  }
  const loops = unique([...loopRows].sort((a, b) => (b.context.scenario.rows ?? 0) - (a.context.scenario.rows ?? 0)),
    row => [row.context.scenario.operation, row.context.scenario.table, row.context.scenario.queryShape, row.context.scenario.hook].join(':')).slice(0, 4);
  if (loops.length) blocks.push(table(['Work performed', 'Extra time for Oyster versus native', 'Calculation iterations per row'], loops.map(row => [operation(row.context.scenario), delta(row), count(row.context.scenario.iterations)])));
  else if (!rowSweep) blocks.push('Not measured: matching READ/scan runs or fixed-workload size comparisons are missing.');
  blocks.push('Size comparisons keep the table, query, calculation and load fixed. A paged scan is timed as one action. Whole-dataset seconds are reported separately only when the complete table was measured.');
  blocks.push('## Response time and throughput under load',
    'Concurrent clients each send another request after the previous request finishes. This tests sustained load at the stated concurrency. **Throughput** is successful requests per second. **p95** is the 95th-percentile request time. The **unrelated probe** is a separate lightweight action called during the load test to check whether the server remains responsive.');
  if (loadSweep) blocks.push(chart(operation(loadSweep.valid[0].group[0].scenario) + ': ' + modes[loadSweep.valid[0].group[0].scenario.mode] + ' under load',
    'Request p95 (ms)', loadSweep.valid.map(p => loadLabel(p.group[0])), loadSweep.valid.map(p => p.stats.mean), 'line'));
  const warmLoads = groups(results.filter(r => r.transport === transport && r.phase === 'warm' && !lowLoad(r)), { mode: true });
  const loadRows = warmLoads.map(group => {
    const repetitions = new Map();
    for (const r of group) {
      if (r.repetition === null || r.repetition === undefined) continue;
      if (!repetitions.has(r.repetition)) repetitions.set(r.repetition, []);
      repetitions.get(r.repetition).push(r);
    }
    const uniqueRuns = [...repetitions.values()].filter(runs => runs.length === 1).map(runs => runs[0]);
    const total = name => { const values = uniqueRuns.map(r => r.stats?.[name]); return values.length && values.every(finite) ? values.reduce((sum, value) => sum + value, 0) : null; };
    const successful = globalInvalid ? [] : group;
    return { group, uniqueRuns, rps: summarize(uniqueRuns.map(r => r.stats?.successfulRps)), p95: metric(successful, 'p95Ms'), probe: metric(successful, 'p95Ms', 'probe'),
      errors: total('errors'), dropped: total('droppedIterations'), failed: uniqueRuns.some(r => !eligible(r)) || globalInvalid };
  });
  const chosenLoads = unique([...loadRows].sort((a, b) => Number(b.failed) - Number(a.failed) || (b.group[0].load.value ?? 0) - (a.group[0].load.value ?? 0)),
    row => [row.group[0].scenario.mode, row.group[0].load.kind, row.group[0].load.value, row.group[0].scenario.mixed, row.group[0].scenario.operation].join(':')).slice(0, 8);
  if (chosenLoads.length) blocks.push(table(['Workload / execution', 'Load', 'Status / runs', 'Successful requests/s', 'Request p95 ms', 'Unrelated probe p95 ms', 'Errors', 'Dropped starts'],
    chosenLoads.map(row => [operation(row.group[0].scenario) + ': ' + modes[row.group[0].scenario.mode] + (row.group[0].scenario.mixed ? ' (mixed READ, INSERT, UPDATE and action)' : ''), loadLabel(row.group[0]),
      (row.failed ? 'Failed' : 'Validated') + ' / ' + row.uniqueRuns.length, number(row.rps.mean), number(row.p95.mean), number(row.probe.mean), number(row.errors), number(row.dropped)])));
  else blocks.push('Not measured: no higher-concurrency or arrival-rate runs are recorded.');
  blocks.push('Throughput averages include successful responses from partially failed runs. Latency uses only validated runs. Errors and dropped starts are totals across the displayed runs. A dropped start is a scheduled request that the generator could not launch. Unrecorded values remain unmeasured. All loads and repetitions are in [Detailed results](details.md).');
  const hasArrivals = warmLoads.some(group => ['rate', 'arrival', 'constant-arrival-rate'].includes(group[0].load.kind));
  const hasClientCpu = warmLoads.length && warmLoads.every(group => group.every(r => finite(r.resources?.clientCpuPercent)));
  blocks.push((hasArrivals ? 'Scheduled arrival-rate measurements are recorded.' : 'The generator does not schedule arrivals independently of response time, so these results do not establish a maximum sustainable incoming request rate.') + ' '
    + (hasClientCpu ? 'Generator CPU use is recorded in the details.' : 'Generator saturation is unverified because its CPU measurements are missing.')
    + ' The generator and server share this machine, and SQLite serializes writes.');
  const environment = manifest.environment || {}, dependencies = environment.dependencies || {};
  const measured = results.filter(r => r.phase === 'warm');
  const successes = measured.length && measured.every(r => finite(r.stats?.successes)) ? measured.reduce((sum, r) => sum + r.stats.successes, 0) : null;
  const failed = results.filter(r => !r.expectedFailure && !eligible(r));
  const limits = results.filter(r => r.expectedFailure || r.phase === 'limit');
  const fixture = manifest.fixture?.tables;
  const data = fixture ? ['SmallRows', 'LargeRows', 'WriteRows', 'LookupRows', 'SideEffectRows'].map(name => [
    { SmallRows: 'Small READ table', LargeRows: 'Large READ table', WriteRows: 'INSERT / UPDATE table', LookupRows: 'Auxiliary lookup table', SideEffectRows: 'Auxiliary update table' }[name], count(fixture[name]?.count)]) : [];
  blocks.push('## Benchmark setup and interpretation',
    'The baseline application omits Oyster. Native and Oyster handlers run in a second application with Oyster installed, so their plugin environment is the same. Fixed service projections expose the same underlying tables for each behavior. Custom data handlers run before INSERT/UPDATE or after READ. Custom actions perform their own work. The runner deploys the retained CSV files with the CDS CLI while CAP is stopped, then reuses each app across its cases. UPDATE requests rotate through seeded rows and INSERT requests use distinct keys.',
    table(['Recorded setting', 'Value'], [
      ['Run date (UTC)', manifest.startedAt?.split('T')[0] || 'not recorded'],
      ['Hardware / operating system', [environment.cpus?.[0]?.model, environment.platform === 'darwin' ? 'macOS' : environment.platform, environment.arch].filter(Boolean).join(' / ') || 'not recorded'],
      ['Node.js / CAP / Oyster / SQLite adapter', [environment.node, dependencies['@sap/cds'], dependencies['@sap/cds-oyster'], dependencies['@cap-js/sqlite']].map(value => value || 'not recorded').join(' / ')],
      ['Protocol', settings.suite || 'not recorded'], ['Warmup / measured interval per case', number(warmup) + ' / ' + number(duration) + ' seconds'],
      ['Independent repetitions', count(settings.repetitions)],
      ['Arithmetic loop iterations per request or returned/scanned row', [...new Set(primary.filter(r => r.scenario.mode.includes('compute')).map(r => r.scenario.iterations))].map(count).join(', ') || 'not recorded'],
      ['Measured runs / successful requests', count(measured.length) + ' / ' + count(successes)],
      ['Validation', manifest.runSummary?.passed === false ? 'Failed or incomplete' : manifest.runSummary?.passed === true ? 'Passed' : 'Completion not recorded'],
    ]));
  if (data.length) blocks.push(table(['Seeded data', 'Rows'], data));
  blocks.push('Request time covers the ' + (transport === 'http' ? 'HTTP request and response' : 'CAP service invocation') + ', including service dispatch, handler work, database work, response handling and transaction completion. Warmup and server startup are outside the measured interval. Mean times average successful requests. With repeated runs, the report averages each run\'s mean or p95. A paired difference compares validated runs of the same operation and workload.',
    failed.length + ' runs failed or were unsuitable for comparison. ' + limits.length + ' limit tests are recorded. Failed, skipped and duplicate runs cannot establish successful overhead. Correctness evidence includes handler activation, response checksums, persisted writes and transaction rollback where recorded.',
    'These measurements describe a local SQLite setup with a single tenant. Small differences can reflect run-to-run variation. Repeated measurements are needed before treating them as stable costs. READ page size, total table size and total scan size must be kept distinct when interpreting large-result behavior.',
    '## Reproduce the benchmark and inspect the evidence',
    'From an authenticated clone of the [benchmark repository](https://github.com/nkaputnik/cds-oyster-performance), run npm install and npm run benchmark for the short protocol, or npm run benchmark:long for repeated and larger workloads. The runner starts the server and load generator, prepares SQLite, and writes a new report directory. The [README](../../README.md) gives prerequisites, stop instructions and complete operator steps.',
    '[Detailed results](details.md) contain every comparison, repetition, resource metric, validation result and failure. [CSV](results.csv), [results JSON](results.json) and [manifest](manifest.json) retain measurements and reproduction metadata. The raw/ and logs/ folders contain request timings and process output. Markdown reports can be regenerated from this evidence without rerunning the benchmark.');
  return blocks.filter(Boolean).join(NL + NL) + NL;
}
