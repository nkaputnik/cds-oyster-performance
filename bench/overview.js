const { readFile, writeFile, mkdir, access } = require('node:fs/promises');
const { resolve, relative, dirname } = require('node:path');
const { createHash } = require('node:crypto');
const { key, eligible, summarize } = require('./report.js');
const { discoverRuns, types } = require('./overview-input.js');

function aggregate(inputs) {
  return Object.fromEntries(Object.entries(inputs).map(([type, input]) => {
    const groups = new Map();
    for (const record of input.results) {
      const match = /^(native|wasm)-(.+)$/.exec(record.scenario?.mode);
      if (!match) continue;
      const identity = JSON.stringify([match[2], JSON.parse(key(record))]);
      if (!groups.has(identity)) groups.set(identity, new Map());
      const reps = groups.get(identity), rep = record.repetition;
      if (rep == null) continue;
      if (!reps.has(rep)) reps.set(rep, { native: [], wasm: [] });
      reps.get(rep)[match[1]].push(record);
    }
    const rows = [];
    for (const [identity, reps] of groups) {
      const pairs = []; let reference;
      for (const [repetition, modes] of [...reps].sort(([a], [b]) => a - b)) {
        if (modes.native.length !== 1 || modes.wasm.length !== 1) continue;
        const [native, oyster] = [modes.native[0], modes.wasm[0]];
        if (![native, oyster].every(r => eligible(r) && r.validation?.passed === true && Number.isFinite(r.stats?.meanMs))) continue;
        const n = native.stats, o = oyster.stats; reference = oyster;
        pairs.push({ input: type, key: identity, repetition, nativeID: native.scenario.id, oysterID: oyster.scenario.id,
          nativeMeanMs: n.meanMs, oysterMeanMs: o.meanMs, extraMeanMs: o.meanMs - n.meanMs,
          overheadPercent: n.meanMs ? 100 * (o.meanMs - n.meanMs) / n.meanMs : null,
          nativeP95Ms: n.p95Ms, oysterP95Ms: o.p95Ms, extraP95Ms: o.p95Ms - n.p95Ms,
          nativeRps: n.successfulRps, oysterRps: o.successfulRps,
          nativeSeconds: native.wholeScanElapsedSeconds, oysterSeconds: oyster.wholeScanElapsedSeconds,
          extraSeconds: oyster.wholeScanElapsedSeconds - native.wholeScanElapsedSeconds });
      }
      if (!pairs.length) continue;
      const row = { key: identity, scenario: reference.scenario, load: reference.load, n: pairs.length, pairs };
      for (const metric of ['nativeMeanMs', 'oysterMeanMs', 'extraMeanMs', 'overheadPercent', 'nativeP95Ms', 'oysterP95Ms', 'extraP95Ms', 'nativeRps', 'oysterRps', 'nativeSeconds', 'oysterSeconds', 'extraSeconds']) row[metric] = summarize(pairs.map(p => p[metric])).mean;
      Object.assign(row, { extraMinMs: summarize(pairs.map(p => p.extraMeanMs)).min, extraMaxMs: summarize(pairs.map(p => p.extraMeanMs)).max });
      rows.push(row);
    }
    return [type, rows.sort((a, b) => a.key.localeCompare(b.key))];
  }));
}
async function writeOverview(root, output) {
  const inputs = await discoverRuns(root, { onSkip: (path, reason) => console.error('Skipped ' + path + ': ' + reason) });
  const data = aggregate(inputs);
  const { renderOverview, renderDetails } = require('./overview-view.js');
  await mkdir(dirname(output), { recursive: true });
  if (!output.endsWith('.md')) throw new Error('Overview output must end in .md');
  const detailRoot = output.slice(0, -3);
  await mkdir(detailRoot, { recursive: true });
  const link = path => relative(dirname(output), path).split('/').map(encodeURIComponent).join('/');
  const reportLinks = {}; const evidence = { method: 'Exact bench/report.js workload identity and mode suffix; one eligible native/Oyster pair per repetition. Equal repetition weights. Percentages calculated within pairs before averaging.', inputs: {} };
  for (const type of types) {
    const input = inputs[type];
    let report = resolve(input.directory, 'report.md');
    try { await access(report); } catch { report = input.directory + '.md'; await access(report); }
    reportLinks[type] = link(report);
    const hashes = {};
    for (const file of ['manifest.json', 'results.json', 'results.csv']) {
      try { hashes[file] = createHash('sha256').update(await readFile(resolve(input.directory, file))).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    evidence.inputs[type] = { directory: relative(dirname(output), input.directory), id: input.manifest.runID || input.manifest.id, startedAt: input.manifest.startedAt, finishedAt: input.manifest.finishedAt, records: input.results.length, settings: input.manifest.settings, hashes, pairedGroups: data[type].length };
    console.log(type + ': ' + input.directory);
  }
  const observations = Object.values(data).flatMap(rows => rows.flatMap(row => row.pairs));
  const columns = [...new Set(observations.flatMap(row => Object.keys(row)))];
  const csvCell = value => { const s = value == null || typeof value === 'number' && !Number.isFinite(value) ? '' : String(value); return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s; };
  await writeFile(resolve(detailRoot, 'comparisons.csv'), [columns.join(','), ...observations.map(row => columns.map(c => csvCell(row[c])).join(','))].join('\n') + '\n');
  await writeFile(resolve(detailRoot, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  await writeFile(resolve(detailRoot, 'details.md'), renderDetails(data));
  await writeFile(output, renderOverview({ inputs, data, reportLinks, evidenceLink: link(resolve(detailRoot, 'evidence.json')), comparisonsLink: link(resolve(detailRoot, 'comparisons.csv')), detailsLink: link(resolve(detailRoot, 'details.md')), sourceRoot: link(resolve(__dirname, '../apps/extension/srv')) + '/' }));
  return output;
}
module.exports = { aggregate, writeOverview };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('npm run overview -- [RUNS_DIRECTORY] [OUTPUT.md] (default: reports, reports/oyster-performance.md). Scans immediate subfolders for newest complete local/BTP short/long runs. Also accepts examples.');
  else if (args.length > 2) { console.error('Expected [RUNS_DIRECTORY] [OUTPUT.md]'); process.exitCode = 1; }
  else { const root = resolve(args[0] || resolve(__dirname, '../reports')); writeOverview(root, resolve(args[1] || resolve(root, 'oyster-performance.md'))).then(path => console.log('Overview: ' + path)).catch(error => { console.error(error.message); process.exitCode = 1; }); }
}
