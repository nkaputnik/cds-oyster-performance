import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import { suite, shuffled } from './scenarios.mjs';
import { APP_ROOT, loadFixture, hashFile } from './fixture.mjs';
import { prepareRuntime, cleanupRuntime } from './prepare.mjs';
import { startServer, executeCommand } from './process.mjs';
import { requestFor } from './requests.mjs';
import { validateActivation, validateResponse, verifyScenario, publicRequest, scanReference } from './verify.mjs';
import { writeReport } from './report.mjs';
import { measureWholeScan } from './whole-scan.mjs';

export function parseArgs(args = process.argv.slice(2)) {
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
  settings.duration = Number(settings.duration ?? (short ? 5 : 12));
  settings.repetitions = Number(settings.repetitions ?? (short ? 1 : 3));
  settings.budgetSeconds = short ? 900 : 5400;
  settings.seed = Number(settings.seed);
  if (!Number.isFinite(settings.warmup) || (settings.warmup !== 0 && settings.warmup < 1)) throw new Error('Invalid warmup');
  if (!Number.isFinite(settings.duration) || settings.duration < 1) throw new Error('Invalid duration');
  if (!Number.isSafeInteger(settings.repetitions) || settings.repetitions < 1) throw new Error('Invalid repetitions');
  if (!Number.isSafeInteger(settings.seed) || settings.seed < 0) throw new Error('Invalid seed');
  if (settings.filter) new RegExp(settings.filter);
  return settings;
}

export function planRuns(settings) {
  const workloads = suite(settings.suite).filter(s => !settings.filter || new RegExp(settings.filter).test(s.id));
  const runs = workloads.map(scenario => ({ scenario, transport: 'http', load: scenario.benchmarkLoad || { kind: 'vus', value: 1 } }));
  return Array.from({ length: settings.repetitions }, (_, i) =>
    shuffled(runs, settings.seed + i).map(run => ({ ...run, repetition: i + 1 }))).flat();
}

const emptyResources = () => ({ cpuPercent: null, rssPeakMiB: null, eventLoopP99Ms: null, gcCount: null, gcMs: null, clientCpuPercent: null });
const emptyStats = () => ({ samples: null, successes: null, errors: null, droppedIterations: null, p50Ms: null, p95Ms: null,
  p99Ms: null, meanMs: null, successfulRps: null, offeredRps: null, completedRps: null, elapsedSeconds: null });
const errorText = error => error?.message || String(error);
const saveJSON = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n');

function singleStats(response, successful, elapsedSeconds) {
  const ms = successful ? response.durationMs : null;
  return { samples: 1, successes: successful ? 1 : 0, errors: successful ? 0 : 1, droppedIterations: 0,
    p50Ms: ms, p95Ms: ms, p99Ms: ms, meanMs: ms, successfulRps: (successful ? 1 : 0) / elapsedSeconds,
    offeredRps: 1 / elapsedSeconds, completedRps: 1 / elapsedSeconds, elapsedSeconds };
}

async function runHTTP(run, { server, fixture, settings, rawDir, prefix, signal }, phase) {
  const summaryFile = resolve(rawDir, prefix + '-' + phase + '.http.json');
  const configFile = resolve(rawDir, prefix + '-' + phase + '.config.json');
  const config = { url: server.url, scenario: run.scenario, fixture, load: run.load, phase,
    seconds: phase === 'warmup' ? settings.warmup : settings.duration,
    probeRate: run.load.value > 1 ? 1 : 0 };
  await saveJSON(configFile, config);
  const command = await executeCommand(process.execPath, [resolve(APP_ROOT, 'bench/load-worker.mjs'), configFile, summaryFile],
    { logPrefix: resolve(rawDir, prefix + '-' + phase + '.http'), signal, measureCpu: true, timeoutMs: (config.seconds + 20) * 1000 });
  let summary = null;
  try { summary = JSON.parse(await readFile(summaryFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { command, summary, summaryFile, configFile };
}

export async function executeRun(run, context) {
  const { server, fixture, settings, rawDir, prefix, signal } = context;
  const base = { ...run, activeState: server.state, runtime: server.runtime.root, resources: emptyResources() };
  const cold = { ...base, phase: 'cold', stats: emptyStats(), rawFile: resolve(rawDir, prefix + '-cold.json') };
  const results = [cold];
  try {
    validateActivation(run.scenario, server.state, server.runtime.expectedHandlers);
    const request = requestFor(run.scenario, fixture, { iteration: 9000000 });
    const response = await publicRequest(server, request, { signal });
    cold.response = response;
    cold.stats = singleStats(response, response.status === request.expectedStatus, response.durationMs / 1000);
    cold.validation = validateResponse(run.scenario, fixture, request, response,
      { scanChecksum: run.scenario.operation === 'scan' ? await scanReference(run.scenario) : undefined });
    cold.validation = await verifyScenario(server, run.scenario, fixture, { signal });
  } catch (error) {
    cold.error = errorText(error);
    cold.validation = { passed: false, reason: cold.error };
    cold.stats.errors ??= 1;
    await saveJSON(cold.rawFile, cold);
    return results;
  }
  await saveJSON(cold.rawFile, cold);
  const warm = { ...base, phase: 'warm', stats: emptyStats(), rawFile: resolve(rawDir, prefix + '-warm.json') };
  results.push(warm);
  try {
    if (settings.warmup > 0) {
      const warmup = await runHTTP(run, context, 'warmup');
      if (warmup.command.code !== 0 || !warmup.summary || warmup.summary.stats.errors > 0)
        throw new Error('HTTP warmup failed; inspect ' + warmup.command.stderrPath);
    }
    await server.call('metrics-start');
    let measurement;
    try { measurement = await runHTTP(run, context, 'measure'); }
    finally { if (server.alive) warm.resources = await server.call('metrics-stop'); }
    if (!measurement.summary) throw new Error('HTTP generator produced no summary; inspect ' + measurement.command.stderrPath);
    Object.assign(warm, { stats: measurement.summary.stats, probe: measurement.summary.probe });
    warm.resources.clientCpuPercent = measurement.command.clientCpuPercent;
    if (measurement.command.code !== 0) throw new Error('HTTP generator exited ' + measurement.command.code);
    if (warm.stats.sampleLimitReached) throw new Error('HTTP sample limit reached');
    if (warm.stats.errors > 0) throw new Error('Measurement contained ' + warm.stats.errors + ' failed requests');
    warm.validation = { preflight: cold.validation,
      postflight: await verifyScenario(server, run.scenario, fixture, { rollback: false, iteration: 8000001, signal }), passed: true };
  } catch (error) { warm.error = errorText(error); warm.validation = { passed: false, reason: warm.error }; }
  warm.serverExit = server.exit;
  await saveJSON(warm.rawFile, warm);
  return results;
}

export async function sourceHashes() {
  const hashes = {};
  async function visit(root) {
    for (const entry of await readdir(resolve(APP_ROOT, root), { withFileTypes: true })) {
      const path = root ? root + '/' + entry.name : entry.name;
      if (entry.isDirectory()) { if (['srv', 'lib', 'bench', '.base', 'db', 'apps'].includes(root ? root.split('/')[0] : entry.name) && entry.name !== 'data' && entry.name !== 'node_modules') await visit(path); }
      else if (/\.(mjs|js|cds|json)$/.test(entry.name) && !entry.name.endsWith('.sqlite')) hashes[path] = await hashFile(resolve(APP_ROOT, path));
    }
  }
  await visit('');
  return hashes;
}

export async function runBenchmark(settings) {
  const campaignStarted = Date.now();
  const fixture = await loadFixture();
  const runs = planRuns(settings);
  if (!runs.length) throw new Error('No scenarios match the selected suite and filter');
  const id = 'bench-' + new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = resolve(APP_ROOT, 'reports', id), rawDir = resolve(reportDir, 'raw');
  await mkdir(rawDir, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Benchmark wall-clock budget reached')), Math.max(1, settings.budgetSeconds * 1000 - (Date.now() - campaignStarted)));
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
      'Cold is the first business invocation after service readiness, without a guarantee of a cold OS cache.',
      'Each runtime database is deployed by the CDS CLI from the model and retained CSV files.'] };
  const results = [];
  let fatal;
  try {
    const dependency = await executeCommand('npm', ['ls', '--all', '--json'], { logPrefix: resolve(rawDir, 'dependencies'), signal: controller.signal });
    manifest.environment.dependencyTreeExitCode = dependency.code;
    manifest.environment.dependencyTreeFile = 'raw/dependencies.stdout.log';
    manifest.environment.dependencyTreeHash = await hashFile(dependency.stdoutPath);
    const tree = JSON.parse(await readFile(dependency.stdoutPath, 'utf8'));
    manifest.environment.dependencies = Object.fromEntries(Object.entries(tree.dependencies || {}).map(([name, detail]) => [name, detail.version]));
    for (const [index, run] of runs.entries()) {
      controller.signal.throwIfAborted();
      const prefix = String(index + 1).padStart(4, '0') + '-' + run.transport + '-rep' + run.repetition;
      console.log('Run ' + (index + 1) + '/' + runs.length + ': ' + run.transport + ' ' + run.scenario.id + ' ' + run.load.kind + '=' + run.load.value);
      let server, runtime;
      try {
        runtime = await prepareRuntime(run.scenario, fixture, { signal: controller.signal });
        server = await startServer(runtime, resolve(reportDir, 'logs', prefix), { signal: controller.signal });
        results.push(...await executeRun(run, { server, fixture, settings, rawDir, prefix, signal: controller.signal }));
      } catch (error) {
        const failed = { ...run, phase: 'cold', stats: emptyStats(), resources: emptyResources(),
          expectedFailure: run.scenario.expectedFailure, error: errorText(error), validation: { passed: false },
          rawFile: resolve(rawDir, prefix + '-startup-error.json') };
        await saveJSON(failed.rawFile, failed); results.push(failed);
      } finally {
        if (server) await server.stop();
        await cleanupRuntime();
      }
      await writeReport(reportDir, manifest, results);
    }
    if (settings.suite === 'long' && !settings.filter && !controller.signal.aborted) {
      await measureWholeScan({ fixture, settings, reportDir, signal: controller.signal, results });
    }
  } catch (error) { fatal = error; manifest.error = errorText(error); }
  finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (controller.signal.aborted) manifest.error ??= errorText(controller.signal.reason);
    manifest.finishedAt = new Date().toISOString();
    manifest.runSummary = { plannedRuns: runs.length, budgetSeconds: settings.budgetSeconds, passed: !manifest.error && results.every(result => result.validation?.passed === true),
      records: results.length, failedRecords: results.filter(result => result.validation?.passed !== true).length };
    await writeReport(reportDir, manifest, results);
  }
  console.log('Benchmark report: ' + resolve(reportDir, 'report.md'));
  if (fatal) throw fatal;
  if (!manifest.runSummary.passed) process.exitCode = 1;
  return { reportDir, manifest, results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const settings = parseArgs();
  if (settings.help) console.log('npm run benchmark -- --suite short|long --warmup SECONDS --duration SECONDS --repetitions COUNT --seed 42 --filter REGEX');
  else await runBenchmark(settings);
}
