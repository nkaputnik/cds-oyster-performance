const { resolve } = require('node:path');
const { mkdir, readFile, writeFile, readdir } = require('node:fs/promises');
const os = require('node:os');
const { suite, shuffled } = require('./scenarios.js');
const { APP_ROOT, OYSTER_ROOT, deploy, loadFixture, hashFile } = require('./fixture.js');
const { startServer, executeCommand } = require('./process.js');
const { requestFor } = require('./requests.js');
const { verifyScenario, writeStateHash } = require('./verify.js');
const { writeReport } = require('./report.js');
const { compactResult, compactManifest } = require('./evidence-format.js');
const { measureWholeScan } = require('./whole-scan.js');

function parseArgs(args = process.argv.slice(2)) {
  const settings = { suite: 'short', seed: 42, transport: 'http' };
  const options = ['suite', 'warmup', 'duration', 'repetitions', 'seed', 'filter'];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--help') { settings.help = true; continue; }
    const name = args[i].replace(/^--/, '');
    if (!args[i].startsWith('--') || !options.includes(name)) throw new Error('Unknown option: ' + args[i]);
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing value for --' + name);
    settings[name] = args[++i];
  }
  suite(settings.suite);
  const short = settings.suite === 'short';
  settings.warmup = Number(settings.warmup ?? (short ? 2 : 3));
  settings.duration = Number(settings.duration ?? (short ? 4 : 10));
  settings.repetitions = Number(settings.repetitions ?? (short ? 1 : 3));
  settings.seed = Number(settings.seed);
  if (!Number.isFinite(settings.warmup) || (settings.warmup !== 0 && settings.warmup < 1)) throw new Error('Invalid warmup');
  if (!Number.isFinite(settings.duration) || settings.duration < 1) throw new Error('Invalid duration');
  if (!Number.isSafeInteger(settings.repetitions) || settings.repetitions < 1) throw new Error('Invalid repetitions');
  if (!Number.isSafeInteger(settings.seed) || settings.seed < 0) throw new Error('Invalid seed');
  if (settings.filter) new RegExp(settings.filter);
  return settings;
}

function planRuns(settings) {
  const workloads = suite(settings.suite).filter(s => !settings.filter || new RegExp(settings.filter).test(s.id));
  const runs = workloads.map(scenario => ({ scenario, transport: 'http', load: scenario.benchmarkLoad || { kind: 'vus', value: 1 } }));
  return Array.from({ length: settings.repetitions }, (_, i) =>
    shuffled(runs, settings.seed + i).sort((a, b) => Number(a.scenario.mode !== 'cap-baseline') - Number(b.scenario.mode !== 'cap-baseline')).map(run => ({ ...run, repetition: i + 1 }))).flat();
}

const emptyResources = () => ({ cpuPercent: null, rssPeakMiB: null, eventLoopP99Ms: null, gcCount: null, gcMs: null, clientCpuPercent: null });
const emptyStats = () => ({ samples: null, successes: null, errors: null, droppedIterations: null, p50Ms: null, p95Ms: null,
  p99Ms: null, meanMs: null, successfulRps: null, offeredRps: null, completedRps: null, elapsedSeconds: null });
const errorText = error => error?.message || String(error);
const saveJSON = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function runHTTP(run, { server, fixture, settings, rawDir, prefix, signal }, phase) {
  const config = { url: server.url, scenario: run.scenario, fixture, load: run.load, phase, headers: server.headers, collectResources: server.cloud === true,
    overallRate: server.cloud && settings.pilot ? 3 : undefined,
    seconds: phase === 'warmup' ? settings.warmup : settings.duration,
    probeRate: run.load.value > 1 ? 1 : 0 };
  let command;
  try { command = await executeCommand(process.execPath, [resolve(APP_ROOT, 'bench/load-worker.js'), '-'],
    { logPrefix: resolve(rawDir, prefix + '-' + phase + '.http'), captureOutput: true, signal, input: JSON.stringify(config), measureCpu: true, timeoutMs: (config.seconds + 20) * 1000 });
  } catch (error) {
    if (phase === 'measure' && error.command?.stdout) {
      try { error.measurementSummary = JSON.parse(error.command.stdout); } catch { /* Preserve diagnostic logs for malformed summaries. */ }
    }
    throw error;
  }
  let summary = null;
  try { summary = JSON.parse(command.stdout); } catch { /* A missing or invalid summary fails the case below. */ }
  return { command, summary };
}

async function executeRun(run, context) {
  const { server, fixture, settings, rawDir, prefix, signal } = context;
  const result = { ...run, phase: 'warm', activeState: server.state, runtime: server.runtime.root,
    stats: emptyStats(), resources: emptyResources(), rawFile: resolve(rawDir, prefix + '.json') };
  try {
    const reference = context.reference;
    const stateHash = context.writeStateHash || writeStateHash;
    const preflight = await verifyScenario(server, run.scenario, fixture, { signal, reference });
    const beforeWrites = run.scenario.validationOutcome === 'rejected' ? await stateHash() : null;
    if (settings.warmup > 0) {
      const warmup = await runHTTP(run, context, 'warmup');
      if (warmup.command.code !== 0 || !warmup.summary || warmup.summary.stats.errors > 0 || (server.cloud && warmup.summary.probe.errors > 0))
        throw new Error('HTTP warmup failed; inspect ' + warmup.command.stderrPath);
    }
    await server.call('metrics-start');
    let measurement;
    try { measurement = await runHTTP(run, context, 'measure'); }
    finally { if (server.alive) result.resources = await server.call('metrics-stop'); }
    if (!measurement.summary) throw new Error('HTTP generator produced no summary');
    Object.assign(result, { stats: measurement.summary.stats, probe: measurement.summary.probe });
    result.resources.clientCpuPercent = measurement.command.clientCpuPercent;
    if (server.cloud) result.generatorResources = measurement.summary.generatorResources;
    if (measurement.command.code !== 0) throw new Error('HTTP generator exited ' + measurement.command.code);
    if (result.stats.sampleLimitReached) throw new Error('HTTP sample limit reached');
    if (result.stats.errors) throw new Error('Measurement contained ' + result.stats.errors + ' failed requests');
    if (server.cloud && result.probe.errors) throw new Error('Provider probe failed');
    if (beforeWrites && beforeWrites !== await stateHash()) throw new Error('Rejected workload changed persisted write rows');
    result.validation = { preflight,
      postflight: await verifyScenario(server, run.scenario, fixture, { rollback: false, iteration: 80001, signal, reference }),
      ...(beforeWrites ? { measuredWritesUnchanged: true } : {}), passed: true };
  } catch (error) {
    if (error.measurementSummary) Object.assign(result, { stats: error.measurementSummary.stats, probe: error.measurementSummary.probe, generatorResources: error.measurementSummary.generatorResources });
    result.error = errorText(error); result.validation = { passed: false, reason: result.error };
  }
  result.serverExit = server.exit;
  if (!context.compactEvidence || !result.validation.passed) await saveJSON(result.rawFile, result);
  return [result];
}

async function sourceHashes() {
  const hashes = {};
  async function visit(root) {
    for (const entry of await readdir(resolve(APP_ROOT, root), { withFileTypes: true })) {
      const path = root ? root + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (['bench', 'apps'].includes(root ? root.split('/')[0] : entry.name) && !['data', 'node_modules', '.runs', '.git', 'reports', 'logs', 'gen'].includes(entry.name)) await visit(path); }
      else if (/\.(mjs|js|cds|csn|json)$/.test(entry.name) && !entry.name.endsWith('.sqlite')) hashes[path] = await hashFile(resolve(APP_ROOT, path));
    }
  }
  await visit('');
  return hashes;
}

async function runBenchmark(settings) {
  const fixture = await loadFixture();
  const runs = planRuns(settings);
  if (!runs.length) throw new Error('No scenarios match the selected suite and filter');
  const id = 'bench-' + new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = resolve(APP_ROOT, 'reports', id), rawDir = resolve(reportDir, 'raw');
  await mkdir(rawDir, { recursive: true });
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error('Benchmark interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  const manifest = { id, startedAt: new Date().toISOString(), settings, fixture,
    commands: { argv: process.argv, cwd: process.cwd() },
    environment: { node: process.version, platform: os.platform(), arch: os.arch(), release: os.release(),
      cpus: os.cpus().map(cpu => ({ model: cpu.model, speedMHz: cpu.speed })), totalMemoryMiB: os.totalmem() / 1024 ** 2,
      sourceHashes: await sourceHashes() },
    validation: { csvDeploymentVerified: true }, runOrder: runs,
    notes: ['HTTP throughput uses observed generator elapsed time; latency contains only successful responses.',
      'Probe counts are separate. Scheduled arrivals and dropped workload iterations are unavailable from autocannon.',
      'Generator CPU uses /usr/bin/time -p when available. 100% equals one CPU core. CPU alone does not establish generator saturation.',
      'Each app is stopped, redeployed from CSVs, and restarted once per repetition. Endpoint cases reuse that server and rotate seeded write rows.'] };
  const results = [];
  let fatal, server, appBatch;
  try {
    const dependency = await executeCommand('npm', ['ls', '--all', '--json'], { logPrefix: resolve(rawDir, 'dependencies'), captureOutput: true, signal: controller.signal });
    manifest.environment.dependencyTreeExitCode = dependency.code;
    const tree = JSON.parse(dependency.stdout);
    manifest.environment.dependencies = Object.fromEntries(Object.entries(tree.dependencies || {}).map(([name, detail]) => [name, detail.version]));
    for (const [index, run] of runs.entries()) {
      controller.signal.throwIfAborted();
      const prefix = String(index + 1).padStart(4, '0') + '-' + run.transport + '-rep' + run.repetition;
      console.log('Run ' + (index + 1) + '/' + runs.length + ': ' + run.transport + ' ' + run.scenario.id + ' ' + run.load.kind + '=' + run.load.value);
      try {
        const root = run.scenario.mode === 'cap-baseline' ? resolve(APP_ROOT, 'apps/baseline-plain') : OYSTER_ROOT;
        const batch = root + ':' + run.repetition;
        if (appBatch !== batch) {
          if (server) await server.stop();
          server = null;
          if (appBatch !== undefined) await deploy({ signal: controller.signal });
          server = await startServer({ root }, resolve(reportDir, 'logs', prefix), { signal: controller.signal });
          manifest.environment.runtimes ||= {};
          manifest.environment.runtimes[run.scenario.mode === 'cap-baseline' ? 'cap' : 'oyster'] = server.state;
          appBatch = batch;
        }
        const caseFixture = { ...fixture, createOffset: index * 32 * 100000 };
        results.push(...(await executeRun(run, { server, fixture: caseFixture, settings, rawDir, prefix, compactEvidence: true, signal: controller.signal })).map(compactResult));
      } catch (error) {
        const failed = { ...run, phase: 'warm', stats: emptyStats(), resources: emptyResources(),
          expectedFailure: run.scenario.expectedFailure, error: errorText(error), validation: { passed: false },
          rawFile: resolve(rawDir, prefix + '-startup-error.json') };
        await saveJSON(failed.rawFile, failed); results.push(failed); throw error;
      }
    }
    if (settings.suite === 'long' && !settings.filter && !controller.signal.aborted) {
      await measureWholeScan({ fixture, settings, reportDir, compactEvidence: true, signal: controller.signal, results, server });
    }
  } catch (error) { fatal = error; manifest.error = errorText(error); }
  finally {
    if (server) await server.stop();
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (controller.signal.aborted) manifest.error ??= errorText(controller.signal.reason);
    manifest.finishedAt = new Date().toISOString();
    manifest.runSummary = { plannedRuns: runs.length, passed: !manifest.error && results.every(result => result.validation?.passed === true),
      records: results.length, failedRecords: results.filter(result => result.validation?.passed !== true).length };
    Object.assign(manifest, compactManifest(manifest));
    delete manifest.runOrder;
    for (let index = 0; index < results.length; index++) results[index] = compactResult(results[index]);
    await writeReport(reportDir, manifest, results);
  }
  console.log('Benchmark report: ' + resolve(reportDir, 'report.md'));
  if (fatal) throw fatal;
  if (!manifest.runSummary.passed) process.exitCode = 1;
  return { reportDir, manifest, results };
}

module.exports = { parseArgs, planRuns, executeRun, sourceHashes, runBenchmark };

if (require.main === module) {
  const settings = parseArgs();
  if (settings.help) console.log('npm run benchmark -- --suite short|long --warmup SECONDS --duration SECONDS --repetitions COUNT --seed 42 --filter REGEX');
  else runBenchmark(settings).catch(error => { console.error(error); process.exitCode = 1; });
}
