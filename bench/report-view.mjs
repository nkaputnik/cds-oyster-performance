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
  if (question === 'Installed plugin overhead') return text + ' Compares plain CAP with Oyster enabled; neither has custom business logic.';
  if (question === 'Sandbox path versus native handler') return text + ' The handler does nothing. Compares an application handler with an Oyster handler.';
  if (question === 'Unimplemented hook routing') return text + ' Compares calling an unimplemented extension point with bypassing it.';
  if (op === 'scan') text += ' It performs ' + count(s.iterations) + ' calculation iterations for every scanned row. Native code issues the page queries directly; Oyster uses CQL callbacks.';
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
  return count(result.load?.value) + (['rate', 'arrival', 'constant-arrival-rate'].includes(result.load?.kind) ? ' requests/s' : ' concurrent users');
}

export function buildHumanReport(manifest, results, api) {
  const { groups, metric, eligible, lowLoad, findingEvidence, callbackEvidence, directCallbackEvidence, sweepEvidence, validationIssues, summarize } = api;
  const globalInvalid = validationIssues(manifest.validation).length > 0;
  const transport = results.some(r => r.transport === 'http') ? 'http' : 'service';
  // Retain invalid and duplicate records until repetition uniqueness has been checked.
  const primary = globalInvalid ? [] : results.filter(r => r.transport === transport);
  const allFindings = findingEvidence(primary);
  const findings = allFindings.filter(row => row.n && row.context.scenario.scanCoordination !== 'external');
  const callbacks = callbackEvidence(primary).filter(row => row.n);
  const directCallbacks = directCallbackEvidence ? directCallbackEvidence(primary).filter(row => row.n) : [];
  const select = (question, rows = findings, predicate = () => true) => best(rows.filter(row => row.question === question && predicate(row)));
  const label = row => operation(row.context.scenario) + ': ' + (questions[row.question] || row.question)
    + (row.context.scenario.hook ? ' through extension point' : '');
  const delta = row => row ? signed(row.mean) + ' ms (' + row.n + ' matched ' + (row.n === 1 ? 'repetition' : 'repetitions') + ')' : 'unanswered: eligible matched controls are missing';
  const answer = (parts, reason) => parts.some(p => p.row) ? parts.map(p => p.label + (p.row ? ' (' + operation(p.row.context.scenario) + ')' : '') + ': ' + delta(p.row)).join('; ') + '.' : 'Unanswered: ' + reason + '.';
  const settings = manifest.settings || {}, warmup = settings.warmup ?? settings.warmupSeconds, duration = settings.duration ?? settings.measureSeconds;
  const exploratory = !['short','long'].includes(settings.suite) && (settings.suite === 'smoke' || (finite(warmup) && warmup < 15) || (finite(duration) && duration < 30));
  const shown = [];
  for (const question of ['Installed plugin overhead', 'Sandbox path versus native handler']) for (const op of ['create', 'update', 'read', 'action']) {
    const row = best(findings.filter(row => row.question === question && row.context.scenario.operation === op));
    if (row) shown.push(row);
  }
  for (const question of ['Execution-location penalty for CPU work', 'CPU plus auxiliary read path', 'CPU plus auxiliary write path'])
    for (const row of findings.filter(row => row.question === question)) if (shown.length < 8 && !shown.includes(row)) shown.push(row);
  const blocks = ['# CDS-Oyster performance results'];
  const whole = primary.filter(r => finite(r.wholeScanElapsedSeconds));
  if (whole.length) {
    const totals = whole.map(r => ({ ...r, stats: { ...r.stats, totalSeconds: r.wholeScanElapsedSeconds } }));
    const points = groups(totals, { mode: true }).map(group => ({ group, summary: metric(group, 'totalSeconds') })).filter(p => finite(p.summary.mean));
    if (points.length) blocks.push('## Processing the whole million-row table', chart('Whole dataset processing', 'Total time (seconds)',
      points.map(p => modes[p.group[0].scenario.mode]), points.map(p => p.summary.mean)),
      'Total seconds include every bounded invocation needed to process the complete dataset. Per-invocation latency is separate in [Detailed results](details.md).');
    const paired = select('Execution-location penalty for CPU work', findingEvidence(whole.map(r => ({ ...r, stats: { ...r.stats, meanMs: r.wholeScanElapsedSeconds * 1000 } }))));
    if (paired) blocks.push('Oyster added **' + signed(paired.mean / 1000) + ' seconds** (' + signed(paired.percent) + '%; ' + paired.n + ' matched repetitions).');
  }
  if (shown.length || !whole.length) blocks.push('## Oyster overhead');
  if (shown.length) blocks.push(chart('Extra time when using Oyster', 'Additional time per request (ms)', shown.map(label), shown.map(row => row.mean)),
    'Positive bars mean Oyster took longer. Each delta pairs the same operation, workload, transport and independent repetition.',
    table(['Situation', 'Test', 'Extra time', 'Change', 'Matched repetitions'], shown.map(row => [label(row), description(row.context.scenario, row.question),
      signed(row.mean) + ' ms', finite(row.percent) ? signed(row.percent) + '%' : 'not measured', row.n])));
  else if (!whole.length) blocks.push(globalInvalid ? 'The recorded validation failed, so this run cannot establish Oyster overhead.' : 'This run has no valid matched comparison for Oyster overhead.');
  const computationRows = findings.filter(row => !row.context.scenario.hook && row.context.scenario.operation !== 'scan' && row.context.scenario.table !== 'LargeRows' &&
    ['Execution-location penalty for CPU work', 'CPU plus auxiliary read path', 'CPU plus auxiliary write path'].includes(row.question)).slice(0, 12);
  if (computationRows.length) blocks.push(chart('Oyster overhead for calculation and CQL', 'Additional request time (ms)', computationRows.map(label), computationRows.map(row => row.mean)),
    'The same calculation runs in CAP and Oyster. CQL variants also read or update an auxiliary table; READ enrichment issues its auxiliary queries once per returned batch.');
  if (settings.suite === 'short') blocks.push('The short version has one independent repetition. Use the long version to assess repeat variability.');
  if (exploratory) blocks.push('**Exploratory timings:** short measurement windows describe this run; they do not establish stable overhead or capacity.');
  if (!manifest.finishedAt) blocks.push('**Completion is not recorded.** Available measurements are shown; remaining coverage is pending.');
  const low = primary.filter(r => lowLoad(r) && r.scenario.scanCoordination !== 'external');
  const reference = groups(low).filter(group => new Set(group.map(r => r.scenario.mode)).size >= 2)
    .sort((a, b) => new Set(b.map(r => r.scenario.mode)).size - new Set(a.map(r => r.scenario.mode)).size)[0];
  if (reference) {
    const points = groups(reference, { mode: true }).map(group => ({ group, summary: metric(group, 'meanMs') })).filter(p => finite(p.summary.mean));
    if (points.length) blocks.push('Absolute times for ' + operation(reference[0].scenario) + ':',
      table(['Execution path', 'Mean request time (ms)', 'Independent repetitions'], points.map(p => [modes[p.group[0].scenario.mode], number(p.summary.mean), p.summary.n])));
  }
  const cpu = select('Execution-location penalty for CPU work');
  const nativeCpu = select('Native calculation versus plain CAP') || select('Native CPU handler overhead');
  const nativeRead = select('Native CQL read versus plain CAP') || select('Native auxiliary read increment');
  const nativeWrite = select('Native CQL write versus plain CAP') || select('Native auxiliary write increment');
  const loopRows = findings.filter(row => row.question === 'Execution-location penalty for CPU work' && ['read', 'scan'].includes(row.context.scenario.operation));
  const scan = best(loopRows.filter(row => row.context.scenario.operation === 'scan'));
  if (directCallbacks.length) blocks.push('## CQL callbacks versus direct database access',
    table(['Operation', 'CQL work', 'Extra callback cost', 'Matched repetitions'], directCallbacks.map(row => [operation(row.context.scenario), row.question.includes('read') ? 'Read' : 'Update', signed(row.mean) + ' ms', row.n])),
    'Compares the CQL increment in Oyster with the CQL increment when native code queries the database directly. Calculation-only controls remove the ordinary handler execution cost from both paths.');
  const sweeps = sweepEvidence(primary);
  const rowSweep = sweeps.find(item => item.sweep.dimension === 'rows' && item.name === 'meanMs' && item.valid[0].group[0].scenario.mode === 'wasm-compute')
    || sweeps.find(item => ['rows', 'scanRows', 'iterations'].includes(item.sweep.dimension) && item.name === 'meanMs');
  const loadSweep = sweeps.find(item => item.sweep.dimension === 'load' && item.name === 'p95Ms' && item.area === 'stats' && item.valid[0].group[0].scenario.mode.startsWith('wasm-'))
    || sweeps.find(item => item.sweep.dimension === 'load' && item.name === 'p95Ms' && item.area === 'stats');
  const sweepAnswer = item => {
    const first = item.valid[0], last = item.valid.at(-1);
    return modes[first.group[0].scenario.mode] + ': ' + number(first.stats.mean) + ' to ' + number(last.stats.mean) + ' ms as '
      + (item.sweep.dimension === 'load' ? 'load increases from ' + loadLabel(first.group[0]) + ' to ' + loadLabel(last.group[0])
        : item.sweep.dimension + ' increase from ' + count(item.value(first.group)) + ' to ' + count(item.value(last.group)))
      + ' (' + first.stats.n + '/' + last.stats.n + ' independent repetitions)';
  };
  const failedLoad = primary.filter(r => r.phase === 'warm' && !lowLoad(r) && !eligible(r));
  blocks.push('## Answers to the six questions', table(['Original question', 'Evidence-backed answer'], [
    ['CAP custom logic', answer([{ label: nativeCpu?.question === 'Native CPU handler overhead' ? 'Calculation versus native empty handler' : 'Calculation versus plain CAP', row: nativeCpu },
      { label: nativeRead?.question === 'Native auxiliary read increment' ? 'Native auxiliary read increment' : 'Calculation + CQL read versus plain CAP', row: nativeRead },
      { label: nativeWrite?.question === 'Native auxiliary write increment' ? 'Native auxiliary write increment' : 'Calculation + CQL write versus plain CAP', row: nativeWrite }], 'no matched native calculation or auxiliary IO controls')],
    ['Execution in Oyster', answer([{ label: 'Equivalent calculation versus native', row: cpu }, { label: 'Calculation + CQL read versus native', row: select('CPU plus auxiliary read path') },
      { label: 'Calculation + CQL write versus native', row: select('CPU plus auxiliary write path') }], 'no matched equivalent native and Oyster calculation/CQL paths')],
    ['Net Oyster overhead', answer([{ label: 'Idle Oyster versus plain CAP', row: select('Installed plugin overhead') }, { label: 'Empty Oyster versus native empty handler', row: select('Sandbox path versus native handler') },
      { label: 'Empty Oyster versus idle Oyster', row: select('Total empty sandbox path') }], 'no matched idle or empty-handler controls')],
    ['Callbacks versus native CQL', answer([{ label: 'Extra read callback cost versus direct database', row: select('Direct database read', directCallbacks) || select('Auxiliary read', callbacks) }, { label: 'Extra update callback cost versus direct database', row: select('Direct database write', directCallbacks) || select('Auxiliary write', callbacks) },
      { label: 'Native service read versus direct database', row: select('Native service versus database read') }, { label: 'Native service update versus direct database', row: select('Native service versus database write') }], 'no matched four-mode callback or direct-database controls')],
    ['Large-result loops', scan || rowSweep || loopRows.length ? (scan ? operation(scan.context.scenario) + ': Oyster versus native ' + delta(scan) + '. ' : '')
      + (rowSweep ? sweepAnswer(rowSweep) + '.' : loopRows.length ? operation(loopRows[0].context.scenario) + ': Oyster versus native ' + delta(loopRows[0]) + '. Further scaling is unanswered.' : 'Returned-row scaling is unanswered.')
      : 'Unanswered: no matched READ/scan loop comparison or workload-preserving row/iteration sweep.'],
    ['Heavy-load behavior', loadSweep ? 'Mean run p95, ' + sweepAnswer(loadSweep) + '. ' + failedLoad.length + ' load records failed; throughput, errors, drops and probe appear below.'
      : 'Unanswered: no successful p95 sweep with fixed workload and load kind. ' + failedLoad.length + ' failed load observations remain visible below.'],
  ]));
  blocks.push('Calculation-only means no auxiliary CQL. INSERT, UPDATE and READ still perform their primary database operation; an action without CQL can run only calculation. Each answer names its comparator; matched workloads and variability are in [Detailed results](details.md).');
  const callbackRows = ['Auxiliary read', 'Auxiliary write'].map(question => select(question, callbacks)).filter(Boolean);
  const dbRows = ['Native service versus database read', 'Native service versus database write', 'Oyster versus direct database read', 'Oyster versus direct database write'].map(question => select(question)).filter(Boolean);
  blocks.push('## What CQL callbacks add', callbackRows.length || dbRows.length ? table(['Comparison', 'Work performed', 'Extra time', 'Matched repetitions'], [
    ...callbackRows.map(row => [row.question === 'Auxiliary read' ? 'Extra Oyster read callback cost' : 'Extra Oyster update callback cost', operation(row.context.scenario), signed(row.mean) + ' ms', row.n]),
    ...dbRows.map(row => [row.question.replace('Native service versus database', 'Native service versus direct database'), operation(row.context.scenario), signed(row.mean) + ' ms', row.n]),
  ]) : 'CQL read: unanswered. CQL write: unanswered. Four matching native/Oyster calculation and calculation-plus-IO modes are required; direct database comparisons need their own matched controls.',
    'Extra callback cost is (Oyster with IO minus Oyster without IO) minus (native with IO minus native without IO), paired within each repetition. It includes validation, query construction, data transfer and their interactions; it does not isolate one additive runtime component.');
  const extension = [['Empty handler', 'Sandbox path versus native handler'], ['Calculation without CQL', 'Execution-location penalty for CPU work'],
    ['Calculation + CQL read', 'CPU plus auxiliary read path'], ['Calculation + CQL write', 'CPU plus auxiliary write path']]
    .map(([name, question]) => [name, select(question, findings, row => row.context.scenario.hook === true)]);
  blocks.push('## Declared extension points', table(['Extension-point work', 'Oyster versus matching native handler'], extension.map(([name, row]) => [name, delta(row)])),
    'Calling an unimplemented extension point versus bypassing it: ' + delta(select('Unimplemented hook routing')) + '. Only that routing comparison omits the hook flag; all external request and workload dimensions must match.');
  blocks.push('## READ sizes and large loops');
  if (rowSweep) {
    const first = rowSweep.valid[0].group[0];
    blocks.push(chart(operation(first.scenario) + ': scaling with ' + modes[first.scenario.mode], rowSweep.axisTitle,
      rowSweep.valid.map(p => count(rowSweep.value(p.group)) + (rowSweep.sweep.dimension === 'iterations' ? ' iterations' : ' rows')), rowSweep.valid.map(p => p.stats.mean), 'line'));
  }
  const loops = unique([...loopRows].sort((a, b) => (b.context.scenario.rows ?? 0) - (a.context.scenario.rows ?? 0)),
    row => [row.context.scenario.operation, row.context.scenario.table, row.context.scenario.queryShape, row.context.scenario.hook].join(':')).slice(0, 4);
  if (loops.length) blocks.push(table(['Workload', 'Oyster versus native', 'Calculation iterations per row'], loops.map(row => [operation(row.context.scenario), delta(row), count(row.context.scenario.iterations)])));
  else if (!rowSweep) blocks.push('Unanswered: no matched READ/scan loops or fixed-workload scaling measurements.');
  blocks.push('The 1,000-row and million-row tables are deployed from retained CSV files. Scaling keeps table, query, computation and load fixed. A paged 10,000-row scan is one invocation; whole-dataset seconds appear only when explicitly measured.');
  blocks.push('## Heavy-load behavior');
  if (loadSweep) blocks.push(chart(operation(loadSweep.valid[0].group[0].scenario) + ': ' + modes[loadSweep.valid[0].group[0].scenario.mode] + ' under load',
    'Mean run p95 (ms)', loadSweep.valid.map(p => loadLabel(p.group[0])), loadSweep.valid.map(p => p.stats.mean), 'line'));
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
  if (chosenLoads.length) blocks.push(table(['Workload / execution', 'Load', 'Status / repetitions', 'Successful requests/s', 'Run p95 ms', 'Unrelated probe p95 ms', 'Errors', 'Dropped starts'],
    chosenLoads.map(row => [operation(row.group[0].scenario) + ': ' + modes[row.group[0].scenario.mode] + (row.group[0].scenario.mixed ? ' (mixed operations)' : ''), loadLabel(row.group[0]),
      (row.failed ? 'Failed' : 'Validated') + ' / ' + row.uniqueRuns.length, number(row.rps.mean), number(row.p95.mean), number(row.probe.mean), number(row.errors), number(row.dropped)])));
  else blocks.push('Unanswered: no higher-concurrency or arrival-rate records.');
  blocks.push('Throughput averages recorded successful requests/s across unique repetitions, including partial failures. Failed records support failure/throughput observations only; p95 and probe latency exclude invalid records. Errors and dropped starts total the shown repetitions. Workload, transport, load kind and mixed operations stay separate; all loads are in [Detailed results](details.md).');
  const hasArrivals = warmLoads.some(group => ['rate', 'arrival', 'constant-arrival-rate'].includes(group[0].load.kind));
  const hasClientCpu = warmLoads.length && warmLoads.every(group => group.every(r => finite(r.resources?.clientCpuPercent)));
  blocks.push((hasArrivals ? 'Arrival-rate measurements are recorded.' : 'This preset measures concurrent load; it does not measure scheduled arrivals.') + ' '
    + (hasClientCpu ? 'Client CPU is recorded in the details.' : 'Generator saturation is unverified because client CPU evidence is missing.')
    + ' Local SQLite serialization and client/server competition can affect these results.');
  const failed = results.filter(r => !r.expectedFailure && !eligible(r)), limits = results.filter(r => r.expectedFailure || r.phase === 'limit');
  blocks.push('## Validation and interpretation', failed.length + ' records failed or were ineligible; ' + limits.length + ' limit probes are recorded. Their timings do not support successful overhead.',
    'Native runs inside CAP; Oyster runs equivalent logic in WASM. Request timing includes dispatch and transaction completion. The overview uses ' + (transport === 'http' ? 'HTTP' : 'CAP service') + '; other transports stay separate in the details. Missing metrics remain unmeasured. Duplicate repetitions are excluded; run percentiles are never pooled into a request-level percentile.',
    'Preset: ' + (settings.suite || 'not recorded') + '; warmup: ' + number(warmup) + ' s; measurement: ' + number(duration) + ' s; planned repetitions: ' + count(settings.repetitions) + '. '
    + (manifest.runSummary?.passed === false ? 'The recorded run summary failed.' : manifest.runSummary?.passed === true ? 'The recorded run summary passed.' : 'Run validation completion is not recorded.'),
    '## Supporting files', '[Detailed results](details.md) contain every comparison, repetition, resource metric, validation result and failure. [CSV](results.csv), [results JSON](results.json) and [manifest](manifest.json) preserve the evidence.',
    'Run npm run benchmark for the short preset or npm run benchmark:long for the long preset. See the [README](../../README.md).');
  return blocks.filter(Boolean).join(NL + NL) + NL;
}
