import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { buildHumanReport } from './report-view.mjs';

const unavailable = 'unavailable';
const workloadFields = ['operation', 'table', 'rows', 'iterations', 'callbacks', 'access', 'hook', 'pageSize', 'scanRows', 'enrichment', 'mixed', 'readTable', 'queryShape', 'offset', 'hookControl', 'actionContract', 'scanCoordination', 'wholeScanRows'];
const statFields = ['samples', 'successes', 'errors', 'droppedIterations', 'p50Ms', 'p95Ms', 'p99Ms', 'meanMs', 'successfulRps', 'offeredRps', 'completedRps', 'elapsedSeconds', 'sampleLimitReached'];
const resourceFields = ['cpuPercent', 'rssPeakMiB', 'eventLoopP99Ms', 'gcCount', 'gcMs', 'clientCpuPercent'];
const comparisons = [
  ['Installed plugin overhead', 'cap-baseline', 'oyster-idle'],
  ['Native handler overhead', 'oyster-idle', 'native-empty'],
  ['Total empty sandbox path', 'oyster-idle', 'wasm-empty'],
  ['Sandbox path versus native handler', 'native-empty', 'wasm-empty'],
  ['Execution-location penalty for CPU work', 'native-compute', 'wasm-compute'],
  ['CPU plus auxiliary read path', 'native-compute-read', 'wasm-compute-read'],
  ['CPU plus auxiliary write path', 'native-compute-write', 'wasm-compute-write'],
  ['Native auxiliary read increment', 'native-compute', 'native-compute-read'],
  ['Native auxiliary write increment', 'native-compute', 'native-compute-write'],
  ['Native calculation versus plain CAP', 'cap-baseline', 'native-compute'],
  ['Native CQL read versus plain CAP', 'cap-baseline', 'native-compute-read'],
  ['Native CQL write versus plain CAP', 'cap-baseline', 'native-compute-write'],
];

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function display(value) {
  if (value === null || value === undefined || (typeof value === 'number' && !finite(value))) return unavailable;
  if (typeof value === 'number') {
    const rounded = Number(value.toFixed(3));
    return String(value !== 0 && rounded === 0 ? Number(value.toPrecision(3)) : rounded);
  }
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function cell(value) {
  const slash = String.fromCharCode(92);
  return display(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split(slash).join(slash + slash).replace(/\|/g, () => slash + '|').replace(/[\r\n]+/g, ' / ')
    .replace(/[*_\[\]]/g, character => slash + character).replaceAll(String.fromCharCode(96), slash + String.fromCharCode(96));
}
function table(headers, rows) {
  return ['| ' + headers.map(cell).join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...rows.map(row => '| ' + row.map(cell).join(' | ') + ' |')].join('\n');
}
function link(path, label = 'raw') {
  if (!path) return unavailable;
  const target = String(path).split('/').map(part => encodeURIComponent(part).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
  return `[${cell(label)}](${target})`;
}
function runLabel(result) {
  return `${display(result.scenario?.id)} / rep ${display(result.repetition)}`;
}
function workload(result, omit = []) {
  return workloadFields.filter(field => !omit.includes(field)).map(field => `${field}=${display(result.scenario?.[field])}`).join('; ')
    + `; transport=${display(result.transport)}; phase=${display(result.phase)}; load=${display(result.load?.kind)}:${display(result.load?.value)}`;
}
function key(result, { mode = false, omit = [] } = {}) {
  const values = workloadFields.filter(field => !omit.includes(field)).map(field => result.scenario?.[field] ?? null);
  return JSON.stringify([...values, result.transport ?? null, result.phase ?? null,
    omit.includes('load') ? null : result.load?.kind ?? null, omit.includes('load') ? null : result.load?.value ?? null,
    mode ? result.scenario?.mode ?? null : null]);
}
function groups(results, options) {
  const grouped = new Map();
  for (const result of results) {
    const groupKey = key(result, options);
    if (!grouped.has(groupKey)) grouped.set(groupKey, []);
    grouped.get(groupKey).push(result);
  }
  return [...grouped.values()];
}
function validationIssues(probe) {
  if (!probe || typeof probe !== 'object') return [];
  const issues = [];
  for (const [name, value] of Object.entries(probe)) {
    if ((['handlerExecuted', 'handlerActive', 'handlerValidated', 'validationPassed', 'fixtureHashVerified', 'passed', 'valid', 'ok'].includes(name) && value === false)
      || (['skipped', 'blocked', 'handlerSkipped', 'handlerBlocked'].includes(name) && value === true)
      || (name === 'status' && ['failed', 'skipped', 'blocked', 'invalid'].includes(value))) issues.push(`${name}=${value}`);
    if (value && typeof value === 'object') issues.push(...validationIssues(value));
  }
  return issues;
}
function eligible(result) {
  return finite(result.stats?.successes) && result.stats.successes > 0
    && !(finite(result.stats?.errors) && result.stats.errors > 0) && !result.error
    && !result.expectedFailure && result.phase !== 'limit' && !result.stats?.sampleLimitReached
    && validationIssues(result.probe).length === 0 && validationIssues(result.validation).length === 0;
}
function lowLoad(result) {
  return result.phase === 'warm' && (result.load?.kind === 'serial' || (result.load?.kind === 'vus' && result.load.value === 1));
}
function summarize(values) {
  const numbers = values.filter(finite);
  if (!numbers.length) return { n: 0, mean: null, sd: null, min: null, max: null };
  const mean = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
  const sd = numbers.length > 1 ? Math.sqrt(numbers.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (numbers.length - 1)) : null;
  return { n: numbers.length, mean, sd, min: Math.min(...numbers), max: Math.max(...numbers) };
}
function independent(group) {
  const repetitions = new Map();
  for (const result of group) {
    const repetition = result.repetition ?? null;
    if (!repetitions.has(repetition)) repetitions.set(repetition, []);
    repetitions.get(repetition).push(result);
  }
  return [...repetitions.entries()].filter(([rep, entries]) => rep !== null && entries.length === 1 && eligible(entries[0])).map(([, entries]) => entries[0]);
}
function metric(group, name, area = 'stats') { return summarize(independent(group).map(result => result[area]?.[name])); }

function tuples(group, selectors) {
  const repetitions = new Map();
  for (const result of group) {
    if (result.repetition === null || result.repetition === undefined) continue;
    if (!repetitions.has(result.repetition)) repetitions.set(result.repetition, []);
    repetitions.get(result.repetition).push(result);
  }
  return [...repetitions.values()].flatMap(runs => {
    const selected = selectors.map(select => runs.filter(select));
    return selected.every(matches => matches.length === 1 && eligible(matches[0]) && finite(matches[0].stats?.meanMs))
      ? [selected.map(matches => matches[0])] : [];
  });
}
function evidence(results, definitions, prefix) {
  const rows = [];
  const candidates = results.filter(lowLoad);
  for (const definition of definitions) {
    let matched = false;
    for (const group of groups(candidates.filter(definition.scope || (() => true)), { omit: definition.omit || [] })) {
      const matchedTuples = tuples(group, definition.selectors);
      if (!matchedTuples.length) continue;
      matched = true;
      const differences = matchedTuples.map(tuple => definition.difference(tuple.map(run => run.stats.meanMs)));
      const summary = summarize(differences.map(value => value.delta));
      rows.push({ question: definition.question, comparison: definition.comparison, workload: workload(group[0], definition.omit),
        context: group[0],
        ...summary, percent: summarize(differences.map(value => value.percent)).mean, id: `${prefix}${rows.length + 1}` });
    }
    if (!matched) rows.push({ question: definition.question, comparison: definition.comparison,
      workload: 'Unanswered: no eligible matched warm low-load repetition tuples', n: 0, mean: null, percent: null, sd: null, id: null });
  }
  return rows;
}
const modeIs = mode => result => result.scenario?.mode === mode;
const pairedDifference = ([base, target]) => ({ delta: target - base, percent: base === 0 ? null : (target - base) / base * 100 });
function findingEvidence(results) {
  const definitions = comparisons.map(([question, base, target]) => ({ question, comparison: `${target} minus ${base}`,
    selectors: [modeIs(base), modeIs(target)], difference: pairedDifference }));
  definitions.push({ question: 'Unimplemented hook routing', comparison: 'oyster-idle hook=true minus oyster-idle hook=false',
    scope: result => result.scenario?.mode === 'oyster-idle' && result.scenario.hookControl === true, omit: ['hook'],
    selectors: [result => result.scenario.hook === false, result => result.scenario.hook === true], difference: pairedDifference });
  definitions.push({ question: 'Native CPU handler overhead', comparison: 'native-compute minus native-empty',
    scope: result => result.scenario?.operation !== 'action' || result.scenario?.actionContract === 'compute',
    selectors: [modeIs('native-empty'), modeIs('native-compute')], difference: pairedDifference });
  for (const io of ['read', 'write']) definitions.push({ question: `Native service versus database ${io}`,
    comparison: `native-compute-${io} access=service minus access=db`, omit: ['access'],
    scope: modeIs(`native-compute-${io}`), selectors: [result => result.scenario.access === 'db', result => result.scenario.access === 'service'],
    difference: pairedDifference });
  for (const [question, target] of [['Native calculation versus plain CAP', 'native-compute'],
    ['Native calculation and read versus plain CAP', 'native-compute-read'],
    ['Native calculation and write versus plain CAP', 'native-compute-write']]) definitions.push({ question,
    comparison: target + ' minus cap-baseline',
    scope: result => result.scenario?.operation !== 'action' || result.scenario?.actionContract === 'compute',
    selectors: [modeIs('cap-baseline'), modeIs(target)], difference: pairedDifference });
  for (const io of ['read', 'write']) definitions.push({ question: 'Oyster versus direct database ' + io,
    comparison: 'wasm-compute-' + io + ' access=service minus native-compute-' + io + ' access=db', omit: ['access'],
    selectors: [result => result.scenario?.mode === 'native-compute-' + io && result.scenario.access === 'db',
      result => result.scenario?.mode === 'wasm-compute-' + io && result.scenario.access === 'service'], difference: pairedDifference });
  return evidence(results, definitions, 'F');
}
function callbackEvidence(results) {
  return evidence(results, ['read', 'write'].map(io => ({ question: `Auxiliary ${io}`,
    comparison: `(wasm-compute-${io} minus wasm-compute) minus (native-compute-${io} minus native-compute)`,
    selectors: ['native-compute', 'wasm-compute', `native-compute-${io}`, `wasm-compute-${io}`].map(modeIs),
    difference: ([nativeCpu, wasmCpu, nativeIo, wasmIo]) => {
      const nativeIncrement = nativeIo - nativeCpu;
      const delta = (wasmIo - wasmCpu) - nativeIncrement;
      return { delta, percent: nativeIncrement === 0 ? null : delta / nativeIncrement * 100 };
    } })), 'C');
}
function directCallbackEvidence(results) {
  return evidence(results, ['read', 'write'].map(io => ({ question: 'Direct database ' + io,
    comparison: 'Oyster CQL increment minus native direct database increment', omit: ['access'],
    selectors: [modeIs('native-compute'), modeIs('wasm-compute'),
      result => result.scenario.mode === 'native-compute-' + io && result.scenario.access === 'db',
      result => result.scenario.mode === 'wasm-compute-' + io && result.scenario.access === 'service'],
    difference: ([nativeCpu, wasmCpu, nativeIo, wasmIo]) => {
      const increment = nativeIo - nativeCpu;
      return { delta: (wasmIo - wasmCpu) - increment, percent: increment === 0 ? null : ((wasmIo - wasmCpu) - increment) / increment * 100 };
    },
  })), 'D');
}
function evidenceTable(rows, percentLabel = 'Mean paired delta (%)') {
  return table(['Question', 'Comparison', 'Matched workload', 'Pairs', 'Mean delta (ms)', percentLabel, 'Delta SD (ms)', 'Evidence row'],
    rows.map(row => [row.question, row.comparison, row.workload, row.n, row.mean, row.percent, row.sd, row.id]));
}

function entries(value, prefix = '') {
  if (!value || typeof value !== 'object') return [[prefix || 'value', value]];
  return Object.entries(value).flatMap(([name, child]) => {
    const path = prefix ? `${prefix}.${name}` : name;
    return child && typeof child === 'object' && !Array.isArray(child) ? entries(child, path) : [[path, child]];
  });
}
function chart(title, axisTitle, points, categories, kind = 'bar') {
  if (!points.length) return '';
  const labels = categories.map((_, index) => `"C${index + 1}"`).join(', ');
  const numbers = points;
  const upper = Math.max(...numbers, 0);
  const ceiling = upper > 0 ? Number((upper * 1.1).toPrecision(8)) : 1;
  return `\n\n### ${title}\n\n`
    + table(['Category', 'Workload / mode', axisTitle], categories.map((category, index) => [`C${index + 1}`, category, points[index]]))
    + `\n\n\`\`\`mermaid\nxychart-beta\n    title "${title}"\n    x-axis [${labels}]\n    y-axis "${axisTitle}" 0 --> ${ceiling}\n    ${kind} [${numbers.join(', ')}]\n\`\`\``;
}
const sweeps = [
  { dimension: 'rows', title: 'Returned-row scaling', metrics: [['meanMs', 'Run mean latency (ms)', 'stats'], ['rssPeakMiB', 'Peak RSS (MiB)', 'resources']] },
  { dimension: 'iterations', title: 'CPU iterations scaling', metrics: [['meanMs', 'Run mean latency (ms)', 'stats']] },
  { dimension: 'scanRows', title: 'Scan row scaling', metrics: [['meanMs', 'Run mean latency (ms)', 'stats'], ['rssPeakMiB', 'Peak RSS (MiB)', 'resources']] },
  { dimension: 'callbacks', title: 'Callback fan-out', metrics: [['meanMs', 'Run mean latency (ms)', 'stats']] },
  { dimension: 'load', title: 'Load latency', metrics: [['p95Ms', 'Mean run p95 latency (ms)', 'stats'], ['successfulRps', 'Successful throughput (requests/s)', 'stats'], ['p95Ms', 'Unrelated-request probe p95 (ms)', 'probe']] },
];
function sweepEvidence(results) {
  const successfulGroups = groups(results.filter(result => result.phase === 'warm'), { mode: true });
  const observations = [];
  for (const sweep of sweeps) {
    const sweepMap = new Map();
    const value = group => sweep.dimension === 'load' ? group[0].load?.value : group[0].scenario?.[sweep.dimension];
    for (const group of successfulGroups) {
      if (!finite(value(group))) continue;
      const groupKey = key(group[0], { mode: true, omit: [sweep.dimension] })
        + (sweep.dimension === 'load' ? `:${group[0].load?.kind}` : '');
      if (!sweepMap.has(groupKey)) sweepMap.set(groupKey, []);
      sweepMap.get(groupKey).push(group);
    }
    for (const sweepGroups of sweepMap.values()) {
      sweepGroups.sort((a, b) => value(a) - value(b));
      for (const [name, axisTitle, area] of sweep.metrics) {
        const valid = sweepGroups.map(group => ({ group, stats: metric(group, name, area) })).filter(item => finite(item.stats.mean));
        if (new Set(valid.map(item => value(item.group))).size < 2) continue;
        observations.push({ sweep, name, axisTitle, area, valid, value, id: `S${observations.length + 1}` });
      }
    }
  }
  return observations;
}
function charts(results) {
  const output = [];
  for (const comparable of groups(results.filter(result => eligible(result) && lowLoad(result)))) {
    const modes = groups(comparable, { mode: true });
    const valid = modes.map(group => ({ group, stats: metric(group, 'meanMs') })).filter(item => finite(item.stats.mean));
    if (valid.length) output.push(chart('Per-operation mean latency', 'Run mean latency (ms)', valid.map(item => item.stats.mean),
      valid.map(item => `${item.group[0].scenario?.mode}; ${workload(item.group[0])}; n=${item.stats.n}`)));
  }
  for (const { sweep, name, axisTitle, area, valid, id } of sweepEvidence(results)) {
    const title = area === 'probe' ? 'Unrelated-request probe' : name === 'successfulRps' ? 'Successful throughput' : sweep.title;
    output.push(chart(`${title} (${id})`, axisTitle, valid.map(item => item.stats.mean),
      valid.map(item => `${item.group[0].scenario?.mode}; ${workload(item.group[0])}; n=${item.stats.n}`), 'line'));
  }
  return output.length ? output.join('') : 'No eligible successful observations are available for charts.';
}

function answers(manifest, results, findings, callbacks) {
  const matched = (questions, rows = findings) => rows.filter(row => row.n && questions.includes(row.question));
  const describe = rows => rows.length ? rows.map(row => `${row.id}: ${row.question}, ${display(row.mean)} ms`
    + `${finite(row.percent) ? ` (${display(row.percent)}%)` : ' (percentage unavailable)'}, n=${row.n}`).join('; ')
    : 'Unanswered: no eligible matched controls.';
  const nativeEmpty = matched(['Native handler overhead']);
  const nativeCpu = matched(['Native CPU handler overhead']);
  const nativeIo = matched(['Native auxiliary read increment', 'Native auxiliary write increment']);
  const execution = matched(['Sandbox path versus native handler', 'Execution-location penalty for CPU work']);
  const net = matched(['Installed plugin overhead', 'Total empty sandbox path', 'CPU plus auxiliary read path', 'CPU plus auxiliary write path', 'Unimplemented hook routing']);
  const callbackRows = callbacks.filter(row => row.n);
  const sweeps = sweepEvidence(results);
  const loopSweeps = sweeps.filter(item => ['rows', 'iterations', 'scanRows'].includes(item.sweep.dimension) && item.name === 'meanMs');
  const loadSweeps = sweeps.filter(item => item.sweep.dimension === 'load');
  const describeSweep = items => items.map(item => {
    const first = item.valid[0], last = item.valid.at(-1);
    return `${item.id}: ${first.group[0].scenario?.mode}, ${item.sweep.dimension} ${item.value(first.group)} to ${item.value(last.group)}, `
      + `${item.axisTitle} ${display(first.stats.mean)} to ${display(last.stats.mean)}`;
  }).join('; ');
  const arrival = loadSweeps.filter(item => ['arrival', 'rate', 'constant-arrival-rate'].includes(item.valid[0].group[0].load?.kind));
  const arrivalClientCpu = arrival.length && arrival.every(item => item.valid.every(point =>
    independent(point.group).every(run => finite(run.resources?.clientCpuPercent))));
  const failedLoad = results.filter(result => result.phase === 'warm' && !lowLoad(result)
    && (result.error || result.stats?.errors > 0 || result.stats?.droppedIterations > 0));
  const rows = [
    ['CAP custom logic with and without DB', `Native empty-handler controls: ${describe(nativeEmpty)} Native incremental service IO: ${describe(nativeIo)} Native CPU controls: ${describe(nativeCpu)} Primary DB-backed operations are identified in the matched workload; auxiliary IO increments include service dispatch, query execution and transaction work. The computation execution-location rows compare native and WASM logic without auxiliary IO.`],
    ['Execution in Oyster', `${describe(execution)} The empty-handler comparison covers the sandbox execution path; the computation comparison covers equivalent loop parameters in native and WASM handlers.`],
    ['Net Oyster overhead', `${describe(net)} Each delta uses the stated baseline and complete request boundary. Installed-plugin, empty-sandbox, IO-path and hook-routing deltas are separate empirical comparisons and cannot be added as isolated component costs.`],
    ['Callbacks versus native CQL', `${describe(callbackRows)} Callback-attribution percentages use native incremental IO as their denominator. The four-mode difference-of-differences is an empirical path comparison; query construction, validation, serialization, service/DB execution and interactions may contribute. Native service versus database controls: ${describe(matched(["Native service versus database read", "Native service versus database write"]))}`],
    ['Large-result loops', loopSweeps.length ? `${describeSweep(loopSweeps)} See the identified scaling tables for all intermediate values, repetition counts and the fixed workload. Returned-row, scan-row and computation-iteration sweeps answer different loop questions; a missing dimension remains unanswered.` : 'Unanswered: no eligible returned-row, scan-row or computation-iteration sweeps with other workload dimensions fixed.'],
    ['Heavy-load behavior', loadSweeps.length ? `${describeSweep(loadSweeps)} ${arrival.length ? 'Scheduled-arrival observations are recorded.' : 'Capacity is unanswered: no matched scheduled-arrival sweep.'} ${arrivalClientCpu ? 'Client CPU is recorded for these arrival observations.' : 'Generator saturation is unverified because scheduled-arrival client CPU evidence is missing.'} ${failedLoad.length} warm load runs record errors or dropped starts; consult the failure table. CPU isolation is unverified.` : 'Unanswered: no eligible load sweep with all non-load workload dimensions and load kind fixed. Capacity, generator saturation and CPU isolation are unverified.'],
  ];
  const caveat = manifest.settings?.suite === 'smoke'
    ? 'These smoke observations provide exploratory timing; they do not establish stable overhead or capacity. Recorded validation determines which execution paths are verified.'
    : 'Conclusions apply only to the measured fixture, settings and host. A single matched repetition does not establish stable overhead or capacity.';
  return table(['Original question', 'Evidence-backed answer'], rows) + '\n\n' + caveat;
}

const sequences = `### Native workload

\`\`\`mermaid
sequenceDiagram
    participant Client
    participant CAP
    participant Native as Native handler
    participant DB as Database
    Client->>CAP: HTTP or service request
    CAP->>Native: Invoke workload handler
    Native->>Native: Deterministic computation
    opt Auxiliary service read or write
        Native->>CAP: srv.run query in request context
        CAP->>DB: Execute query
        DB-->>CAP: Query result
        CAP-->>Native: Query result
    end
    Native-->>CAP: Handler completes
    CAP->>DB: Complete request transaction
    DB-->>CAP: Completion
    CAP-->>Client: Request result
\`\`\`

### Oyster and srvQuery callback

\`\`\`mermaid
sequenceDiagram
    participant Client
    participant CAP
    participant Host as Oyster host
    participant WASM as WASM sandbox
    participant DB as Database
    Client->>CAP: HTTP or service request
    CAP->>Host: Invoke deployed handler
    Host->>WASM: Serialize request and execute handler
    WASM->>WASM: Deterministic computation
    opt Auxiliary read or write
        WASM->>Host: srvQuery callback with serialized CQL
        Host->>Host: Validate query and restore CAP context
        Host->>CAP: srv.run query in request context
        CAP->>DB: Execute query
        DB-->>CAP: Query result
        CAP-->>Host: Query result
        Host-->>WASM: Serialized callback result
    end
    WASM-->>Host: Serialized handler result
    Host-->>CAP: Handler completes
    CAP->>DB: Complete request transaction
    DB-->>CAP: Completion
    CAP-->>Client: Request result
\`\`\`

### Declared extension point

\`\`\`mermaid
sequenceDiagram
    participant Client
    participant App as Application handler
    participant Hook as Extension service hook
    participant Handler as Native or Oyster implementation
    Client->>App: Trigger operation
    App->>Hook: Await declared hook with fixed parameters
    alt Hook implementation present
        Hook->>Handler: Invoke implementation in request context
        Handler-->>Hook: Implementation completes
    else No hook implementation
        Hook->>Hook: Unimplemented hook control
    end
    Hook-->>App: Hook completes
    App-->>Client: Operation and transaction complete
\`\`\``;

export function buildDetailedReport(manifest = {}, results = []) {
  const manifestIssues = validationIssues(manifest.validation);
  const performanceResults = manifestIssues.length ? [] : results;
  const findingRows = findingEvidence(performanceResults);
  const callbackRows = callbackEvidence(performanceResults);
  const allGroups = groups(results, { mode: true });
  const latencyRows = results.map(result => [runLabel(result), result.scenario?.mode, workload(result),
    ...statFields.map(name => result.stats?.[name]), result.scenario?.expectedCallbacks, result.rawFile || unavailable]);
  const latency = table(['Run', 'Mode', 'Workload', 'Samples', 'Successes', 'Errors', 'Dropped starts', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'Mean (ms)',
    'Successful requests/s', 'Offered requests/s', 'Completed requests/s', 'Elapsed (s)', 'Sample cap reached', 'Expected callbacks', 'Raw file'], latencyRows);
  const resourceRows = results.map(result => [runLabel(result), result.scenario?.mode, ...resourceFields.map(name => result.resources?.[name])]);
  const variabilityRows = allGroups.map(group => {
    const validGroup = manifestIssues.length ? [] : group;
    const mean = metric(validGroup, 'meanMs');
    const p95 = metric(validGroup, 'p95Ms');
    const rps = metric(validGroup, 'successfulRps');
    return [group[0].scenario?.mode, workload(group[0]), mean.n, mean.mean, mean.sd, mean.min, mean.max,
      p95.n, p95.mean, p95.sd, rps.n, rps.mean, rps.sd];
  });
  const failureRows = results.filter(result => result.phase === 'limit' || result.expectedFailure || result.error
    || result.stats?.successes === 0 || result.stats?.errors > 0 || result.stats?.droppedIterations > 0).map(result => [
    runLabel(result), result.scenario?.mode, result.phase, result.expectedFailure, result.stats?.successes, result.stats?.errors, result.stats?.droppedIterations, result.error, result.rawFile]);
  const probeRows = results.flatMap(result => ['validation', 'probe'].filter(field => result[field] !== undefined)
    .flatMap(field => entries(result[field], field).map(([name, value]) => [runLabel(result), name, value])));
  const rawLinks = [...new Set(results.map(result => result.rawFile).filter(Boolean))].map(path => link(path, path)).join(', ');
  const report = [
    `# Oyster performance report: ${cell(manifest.id)}`,
    results.length ? `${results.length} measured runs are recorded. Tables retain all observations; findings and charts exclude failed, skipped, blocked and limit-probe runs.` : 'No measured runs are recorded. Performance questions remain unanswered.',
    '## Findings',
    evidenceTable(findingRows),
    'Pairs use run means from the same independent repetition, operation, table, returned rows, computation iterations, nominal callback loop count, data-access path, hook, page size, scan rows, enrichment, mixed flag, read table, query shape, offset, hook control, transport, phase and load. Scenario IDs, modes and expectedCallbacks metadata are excluded from the workload match. Only warm serial or one-user load results support the overhead table. A missing or duplicated repetition pair is excluded. Positive delta means a slower target. Percentages are the arithmetic mean of paired relative deltas; a zero baseline leaves its percentage unavailable. SD uses independent repetition deltas and is unavailable for a single pair.',
    'Unimplemented hook routing compares oyster-idle hook=true with oyster-idle hook=false only when both declare hookControl=true. Only this pairing omits hook from matching; its controls must preserve identical external requests, response shape and application work. The fixture validation establishes those contracts. These differences describe complete execution paths. Percentiles are per-run observations; differences between percentiles do not isolate component distributions.',
    '## Callback attribution',
    evidenceTable(callbackRows, 'Mean percentage of native incremental IO (%)'),
    'Within each independent repetition, auxiliary read/write attribution is (WASM computation plus IO minus WASM computation) minus (native computation plus IO minus native computation). All four eligible modes must match every workload dimension, transport, phase and load exactly. The nominal callback loop count stays fixed; expectedCallbacks records actual callback expectations and can differ between computation and IO modes. Percentages are the mean of repetition-level deltas divided by the native incremental IO cost in the same repetition; a zero denominator is unavailable. This is an empirical path comparison, including query construction, validation, serialization, service/DB execution and their interactions. It does not establish an isolated additive callback cost.',
    '## Per-run latency and throughput',
    results.length ? latency : 'No measured runs.',
    'Every workload dimension appears in the table. The static endpoint protocol records warmed measurements. Historical cold timings and limit probes, when present, remain separate; a fresh server process does not establish a cold operating-system cache. Unavailable metrics are never replaced with zero. Display values round to three decimals, retaining three significant digits for smaller nonzero values; JSON and CSV preserve the recorded precision.',
    '## Independent repetition variability',
    table(['Mode', 'Workload', 'Mean n', 'Mean of run means (ms)', 'SD of run means (ms)', 'Min run mean (ms)', 'Max run mean (ms)',
      'p95 n', 'Mean run p95 (ms)', 'SD run p95 (ms)', 'Throughput n', 'Mean successful requests/s', 'SD successful requests/s'], variabilityRows),
    'Each n counts eligible independent repetitions for that metric. Missing metrics reduce n. Duplicate repetition IDs within a mode and workload are excluded from variability and charts. Run percentiles are summarized across repetitions and are never pooled into a request-level percentile or treated as independent experiments.',
    '## Per-run resources',
    results.some(result => finite(result.wholeScanElapsedSeconds)) ? table(['Whole scan run', 'Mode', 'Whole rows', 'Bounded invocations', 'Whole elapsed (s)'],
      results.filter(result => finite(result.wholeScanElapsedSeconds)).map(result => [runLabel(result), result.scenario?.mode, result.scenario?.wholeScanRows, result.stats?.samples, result.wholeScanElapsedSeconds])) : '',
    table(['Run', 'Mode', 'Server CPU (%)', 'Peak RSS (MiB)', 'Event-loop p99 (ms)', 'GC count', 'GC time (ms)', 'Client CPU (%)'], resourceRows),
    'Client CPU is necessary to assess generator saturation. Unavailable client CPU or missing scheduled-arrival sweeps leave the capacity question unanswered. SQLite write serialization and client/server competition on the same host can affect results.',
    '## Measured charts',
    charts(performanceResults),
    'Charts use a single basic Mermaid series with category mappings in the adjacent tables. Values are means of eligible independent run metrics. Missing or failed observations are omitted. No illustrative measurements are included. Scaling and fan-out conclusions require multiple values with every other workload dimension fixed; load sweeps also preserve the load kind. Missing sweeps leave those questions unanswered.',
    '## Failures and limit probes',
    failureRows.length ? table(['Run', 'Mode', 'Phase', 'Expected failure', 'Successes', 'Errors', 'Dropped starts', 'Error', 'Raw file'], failureRows) : 'No failures or limit probes are recorded. This does not establish untested limits.',
    'Failures, partial errors and dropped arrivals affect interpretation even when some requests succeed. Expected failures are not performance successes. A handler skipped after a failure cannot support a throughput improvement.',
    '## Handler and correctness validation',
    table(['Manifest validation check', 'Recorded value'], entries(manifest.validation)),
    manifestIssues.length ? `Manifest validation failed (${cell(manifestIssues.join('; '))}); no runs support performance findings or charts.` : 'No explicit manifest-wide validation failure is recorded.',
    probeRows.length ? table(['Run', 'Probe field', 'Recorded value'], probeRows) : 'No per-run handler or correctness probes are recorded; continued handler execution and unrelated-request impact are unverified.',
    'Validation and handler execution must be checked before interpreting timing. Skipped, blocked or explicitly invalid handler probes are excluded from findings and successful charts. Probe latency alone does not prove handler correctness. SQL/query-count, checksum, rollback and side-effect checks are established only by the recorded validation evidence.',
    '## Reproduction metadata',
    manifest.runSummary ? table(['Run completion field', 'Recorded value'], entries(manifest.runSummary)) : '',
    table(['Field', 'Recorded value'], entries({ id: manifest.id, startedAt: manifest.startedAt, finishedAt: manifest.finishedAt, settings: manifest.settings, environment: manifest.environment, fixture: manifest.fixture })),
    'The manifest records actual versions, configuration, hardware, source revision, fixture hashes and timing settings when provided. Measurements cover the client request through transaction completion; handler-only diagnostics have a different boundary. Warm-up and process startup are outside warm timing. Renderer version and renderer validation are established only if recorded in the manifest.',
    '## Execution paths',
    'These diagrams describe the intended fixture paths and timing boundaries; validation establishes which paths executed in each run.',
    sequences,
    '## Evidence',
    '[Manifest](manifest.json), [Results JSON](results.json), [Results CSV](results.csv).',
    rawLinks ? `Raw run files: ${rawLinks}.` : 'No raw run files are recorded.',
    '## Answers to the original questions',
    answers(manifest, performanceResults, findingRows, callbackRows),
  ].join('\n\n');
  return report + '\n';
}

export function buildReport(manifest = {}, results = []) {
  return buildHumanReport(manifest, results, { groups, metric, eligible, lowLoad, findingEvidence, callbackEvidence, directCallbackEvidence, sweepEvidence, validationIssues, summarize });
}
export const renderReport = buildReport;

function csvCell(value) {
  const text = finite(value) ? String(value) : display(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
function csv(results) {
  const callbackByteFields = [...new Set(results.flatMap(result => ['validation', 'probe'].flatMap(field =>
    entries(result[field], field).map(([name]) => name).filter(name => name.split('.').includes('callbackBytes')))))];
  const columns = [
    ...['id', 'mode', ...workloadFields, 'expectedCallbacks'].map(field => [`scenario.${field}`, result => result.scenario?.[field]]),
    ...['repetition', 'transport', 'phase', 'wholeScanElapsedSeconds'].map(field => [field, result => result[field]]),
    ...['kind', 'value'].map(field => [`load.${field}`, result => result.load?.[field]]),
    ...statFields.map(field => [`stats.${field}`, result => result.stats?.[field]]),
    ...resourceFields.map(field => [`resources.${field}`, result => result.resources?.[field]]),
    ...callbackByteFields.map(field => [field, result => field.split('.').reduce((value, name) => value?.[name], result)]),
    ...['rawFile', 'validation', 'probe', 'expectedFailure', 'error'].map(field => [field, result => result[field]]),
  ];
  return [columns.map(([name]) => csvCell(name)).join(','), ...results.map(result => columns.map(([, get]) => csvCell(get(result))).join(','))].join('\r\n') + '\r\n';
}

export async function writeReport(outputDir, manifest, results) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await writeFile(join(outputDir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  await writeFile(join(outputDir, 'results.csv'), csv(results));
  return writeMarkdownReports(outputDir, manifest, results);
}

export async function writeMarkdownReports(outputDir, manifest, results) {
  const linkedResults = results.map(result => ({ ...result, rawFile: result.rawFile && isAbsolute(result.rawFile) ? relative(outputDir, result.rawFile) : result.rawFile }));
  const reportPath = join(outputDir, 'report.md');
  await writeFile(reportPath, buildReport(manifest, linkedResults));
  await writeFile(join(outputDir, 'details.md'), buildDetailedReport(manifest, linkedResults));
  return reportPath;
}
