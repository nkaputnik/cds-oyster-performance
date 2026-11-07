const { cloudSuite, shuffled } = require("../scenarios.js");
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { mkdir, readFile, writeFile, readdir, copyFile, mkdtemp, rm } = require('node:fs/promises');
const { resolve, dirname } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parseArgs, executeRun, sourceHashes } = require('../run.js');
const { APP_ROOT } = require('../fixture.js');
const { writeReport } = require('../report.js');
const { compactResult, compactManifest } = require('../evidence-format.js');
const { createCloudFixture } = require('./fixture.js');
const { createEvidenceClient } = require('./evidence.js');
const { createTenantAuth } = require('./auth.js');
const { ResourceSampler } = require('../resources.js');
const { publicRequest, validateActivation } = require('../verify.js');
const { scenario } = require('../scenarios.js');
const { cpu } = require('../../apps/provider/srv/lib/workload.js');
function planCloudRuns(settings) {
  const workloads = (settings.pilot ? pilotSuite() : cloudSuite(settings.suite)).filter(s => !settings.filter || new RegExp(settings.filter).test(s.id));
  const groups = new Map();
  for (const scenario of workloads) {
    const { mode, id, expectedCallbacks, benchmarkLoad, ...work } = scenario;
    const load = settings.pilot ? { kind: 'vus', value: 1, overallRate: 3, protocol: 'rate-limited-pilot' } : benchmarkLoad || { kind: "vus", value: 1 };
    const key = JSON.stringify([work, mode.replace(/^(native|wasm)-/, "paired-"), load]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ scenario, transport: "http", load, pairID: key });
  }
  return Array.from({ length: settings.repetitions }, (_, index) => shuffled([...groups.values()], settings.seed + index)
    .sort((a,b) => a[0].load.value - b[0].load.value).flatMap(group => {
      const paired = group.length === 2 && group.some(run => run.scenario.mode.startsWith("native-")) && group.some(run => run.scenario.mode.startsWith("wasm-"));
      return group.sort((a,b) => (index % 2 ? -1 : 1) * (Number(a.scenario.mode.startsWith("wasm-")) - Number(b.scenario.mode.startsWith("wasm-"))))
        .map(run => ({ ...run, pairID: paired ? run.pairID : null, repetition: index + 1 }));
    })).flat();
}
function pilotSuite() {
  return [
    ...['native-empty', 'wasm-empty'].map(mode => scenario({ mode, operation: 'action' })),
    ...['native-compute-read', 'wasm-compute-read'].map(mode => scenario({ mode, operation: 'action', lookupPattern: 'batch' })),
    ...['native-validate', 'wasm-validate'].flatMap(mode => ['accepted', 'rejected'].flatMap(validationOutcome => [
      ...['create', 'update'].map(operation => scenario({ mode, operation, validationOutcome })),
      scenario({ mode, operation: 'action', validationOutcome, hook: true }),
    ])),
    ...['native-empty', 'wasm-empty'].flatMap(mode => ['page', 'key', 'range', 'non-indexed', 'offset'].map(queryShape => scenario({ mode, operation: 'read', queryShape, offset: queryShape === 'offset' ? 100 : 0 }))),
    ...['native-compute-read', 'wasm-compute-read'].map(mode => scenario({ mode, operation: 'read', mixed: true, benchmarkLoad: { kind: 'vus', value: 8 } })),
  ];
}
function checkState(state, baseline, owner) {
  assert.equal(state.extensionHealthy, true, 'Tenant extension missing, changed or blocked');
  assert.equal(state.engine, 'oyster', 'Oyster engine required');
  if (baseline) for (const field of ['tenant', 'extensionFingerprint']) assert.equal(state[field], baseline[field], 'Provider ' + field + ' changed');
  if (baseline) {
    assert.equal(state.instance.ID, baseline.instance.ID, 'Provider restarted');
    assert.deepEqual(state.versions, baseline.versions, 'Provider dependency versions changed');
    assert.deepEqual(state.limits, baseline.limits, 'Provider Oyster limits changed');
  }
  if (owner) {
    assert.equal(state.lease?.active, true, 'Campaign lease lost');
    assert.equal(state.lease?.owner, owner, 'Campaign lease overlap');
  }
  return state;
}

async function cloudScanChunks(adapter, fixture, { chunkRows = 50000, iterations = 100, signal } = {}) {
  const rows = fixture.tables.LargeRows.count, chunks = [];
  let cursor = fixture.tables.LargeRows.minID - 1;
  for (let offset = 0; offset < rows;) {
    const count = Math.min(chunkRows, rows - offset);
    let checksum = 0, lastID = cursor;
    for (let fetched = 0; fetched < count;) {
      signal?.throwIfAborted();
      const size = Math.min(10000, count - fetched);
      const read = scenario({ mode: 'oyster-idle', operation: 'read', table: 'LargeRows', queryShape: 'offset', rows: size, offset: offset + fetched });
      const reference = await adapter.readReference(read, fixture, { path: '/benchmark/NoHandlerLargeRows?$top=' + size + '&$skip=' + (offset + fetched) });
      assert.equal(reference.length, size, 'Cloud whole-scan reference row count');
      for (const row of reference) { assert.ok(row.ID > lastID, 'Cloud reference ordered keys'); checksum = (checksum + cpu(row.value, iterations)) & 2147483647; lastID = row.ID; }
      fetched += size;
    }
    chunks.push({ cursor, count, checksum, lastID }); cursor = lastID; offset += count;
  }
  return chunks;
}

async function executeCloudScan(run, { server, adapter, chunks, rawDir, prefix, signal, auth, compactEvidence = false }) {
  const result = { ...run, phase: 'warm', rawFile: resolve(rawDir, prefix + '.json'), activeState: server.state };
  let sampling = false, sampler;
  try {
    validateActivation(run.scenario, server.state);
    const invoke = async chunk => {
      signal.throwIfAborted();
      if (auth.expiresAt && auth.expiresAt < Date.now() + 120000) throw new Error('OAuth expiry cannot cover next complete scan invocation');
      const response = await publicRequest(server, { method: 'POST', path: '/benchmark/' + (run.scenario.mode.startsWith('wasm-') ? 'oysterScan' : 'nativeScan'),
        headers: { 'content-type': 'application/json' }, body: { cursor: chunk.cursor, count: chunk.count, pageSize: 1000, iterations: 100 } }, { signal });
      assert.equal(response.status, 200, 'Whole-scan HTTP status'); assert.equal(response.body.value, chunk.checksum, 'Whole-scan reference result');
      return { ...chunk, durationMs: response.durationMs, status: response.status, result: response.body.value };
    };
    await invoke(chunks[0]); await adapter.metricsStart(); sampling = true;
    sampler = new ResourceSampler().start();
    const started = performance.now(); result.invocations = [];
    for (const chunk of chunks) result.invocations.push(await invoke(chunk));
    result.wholeScanElapsedSeconds = (performance.now() - started) / 1000;
    result.generatorResources = sampler.stop(); sampler = null;
    result.resources = await adapter.metricsStop(); sampling = false;
    const durations = result.invocations.map(item => item.durationMs).sort((a,b) => a-b), p = fraction => durations[Math.ceil(durations.length * fraction) - 1];
    result.stats = { samples: durations.length, successes: durations.length, errors: 0, droppedIterations: 0,
      meanMs: durations.reduce((sum,value) => sum + value, 0) / durations.length, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99),
      successfulRps: durations.length / result.wholeScanElapsedSeconds, elapsedSeconds: result.wholeScanElapsedSeconds };
    result.validation = { passed: true, everyChecksumVerified: true, rows: run.scenario.wholeScanRows };
  } catch (error) { result.error = error.message; result.validation = { passed: false }; }
  finally {
    if (sampler) result.generatorResources = sampler.stop();
    if (sampling) { try { result.resources = await adapter.metricsStop(); } catch (error) { result.metricsCleanupError = error.message; } }
    if (!compactEvidence || !result.validation.passed) await writeFile(result.rawFile, JSON.stringify(result, null, 2));
  }
  return [result];
}

function cloudNetwork(baseUrl, mode, allowLoopback) {
  if (!['container-to-container', 'cf-router'].includes(mode)) throw new Error('Cloud network path must be container-to-container or cf-router');
  let route;
  try { route = new URL(baseUrl); } catch { throw new Error('Controlled provider root URL required for the selected network path'); }
  const internal = route.hostname.endsWith('.apps.internal') && ['http:', 'https:'].includes(route.protocol);
  const publicCF = route.protocol === 'https:' && /\.cfapps\.[a-z0-9.-]+$/i.test(route.hostname);
  // Injected authentication permits the existing local integration harness only.
  const loopback = allowLoopback && mode === 'container-to-container' && ['127.0.0.1', 'localhost', '[::1]'].includes(route.hostname) && ['http:', 'https:'].includes(route.protocol);
  if ((mode === 'cf-router' ? !publicCF : !internal && !loopback) || route.username || route.password || route.search || route.hash || route.pathname !== '/')
    throw new Error('Controlled provider root URL required for the selected network path');
  return { mode: loopback ? 'local-test' : mode, protocol: route.protocol, hostname: route.hostname,
    port: route.port || (route.protocol === 'https:' ? '443' : '80'), tls: route.protocol === 'https:',
    path: loopback ? 'Local HTTP test harness' : mode === 'cf-router' ? 'CF router' : 'CF container-to-container' };
}

async function runCloudBenchmark(settings, { baseUrl = process.env.BENCHMARK_PROVIDER_URL, auth, reportDir,
  networkPath = process.env.BENCHMARK_NETWORK_PATH ?? 'container-to-container',
  environment = {}, signal, adapter, evidence, onProgress = () => {} } = {}) {
  const network = cloudNetwork(baseUrl, networkPath, Boolean(auth));
  const renewals = [];
  auth ||= createTenantAuth({ subdomain: process.env.BENCHMARK_SUBDOMAIN, tenantID: process.env.BENCHMARK_TENANT_ID, providerUrl: baseUrl,
    allowPublicProvider: networkPath === 'cf-router', onRenewal: event => renewals.push(event) });
  auth.assertProvider(baseUrl);
  const runs = planCloudRuns(settings);
  if (!runs.length) throw new Error('No cloud scenarios match the selected suite and filter');
  const controller = new AbortController();
  let committing = false;
  const interrupt = () => { if (!committing) controller.abort(new Error('Cloud benchmark interrupted')); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
  const campaignSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const id = 'cloud-' + new Date().toISOString().replace(/[:.]/g, '-'), owner = id + '-' + randomUUID();
  reportDir ||= resolve(process.env.BENCHMARK_OUTPUT_ROOT || APP_ROOT + '/reports', id);
  const rawDir = resolve(reportDir, 'raw'); await mkdir(rawDir, { recursive: true });
  adapter ||= createCloudFixture({ baseUrl, headers: () => auth.headers });
  const evidenceOptions = { url: baseUrl.replace(/\/+$/, '') + '/benchmark-evidence', headers: () => auth.headers, scratch: reportDir };
  const suppliedEvidence = Boolean(evidence);
  evidence ||= createEvidenceClient({ ...evidenceOptions, signal: campaignSignal });
  const results = [], artifacts = [];
  const manifest = { id, startedAt: new Date().toISOString(), settings, runOrder: [...runs], environment: { execution: 'cloud', database: 'HANA',
    measurementProtocol: settings.pilot ? 'rate-limited-pilot' : 'closed-loop-concurrency', workloadRateCapRps: settings.pilot ? 3 : null,
    hana: { instanceID: process.env.BENCHMARK_HANA_ID || null, memoryGiB: process.env.BENCHMARK_HANA_MEMORY_GB ? Number(process.env.BENCHMARK_HANA_MEMORY_GB) : null,
      storageGiB: process.env.BENCHMARK_HANA_STORAGE_GB ? Number(process.env.BENCHMARK_HANA_STORAGE_GB) : null },
    foundation: process.env.BENCHMARK_FOUNDATION || null, region: process.env.BENCHMARK_REGION || null, ...environment, node: process.version,
    network,
    runner: { instanceID: process.env.CF_INSTANCE_GUID || null, taskName: process.env.CF_TASK_NAME || null, memoryLimit: process.env.MEMORY_LIMIT || null },
    deployedArtifacts: { providerBuildSha256: process.env.BENCHMARK_PROVIDER_BUILD_SHA256 || null, extensionArchiveSha256: process.env.BENCHMARK_EXTENSION_ARCHIVE_SHA256 || null,
      deploymentArchiveSha256: process.env.BENCHMARK_DEPLOYMENT_ARCHIVE_SHA256 || null },
    authenticationRenewals: renewals, hanaDiagnostics: 'Unavailable: no HANA server resource diagnostics are collected.' },
    validation: {}, reporting: { measurementBatchSize: 20 }, notes: [settings.pilot ? 'Rate-limited setup pilot with configured overallRate=3; upload, resets and authentication renewal occur outside measured windows.' : 'Closed-loop HTTP concurrency; upload, resets and authentication renewal occur outside measured windows.', 'Provider and generator CPU/RSS/event-loop samples are separate. CPU alone does not establish generator saturation.', 'Compact measurements persist in batches of 20 and at completion. Individual response timings are used to compute exact statistics and then discarded. Reports are generated after measurement.'] };
  let runID, lease = false, baseline, fatal, repetition, chunks, flushed = 0;
  const upload = async path => { const artifact = await evidence.uploadArtifact({ runID, path, root: reportDir }); artifacts.push({ ID: artifact.ID, path: artifact.path, originalSha256: artifact.originalSha256 }); return artifact; };
  const flushMeasurements = async () => {
    if (flushed === results.length) return;
    const first = flushed + 1, last = results.length;
    const original = 'measurements/' + String(first).padStart(4, '0') + '-' + String(last).padStart(4, '0') + '.json';
    const stored = await evidence.listArtifacts(runID);
    const existing = stored.find(artifact => artifact.path === original);
    let artifact = existing;
    if (existing?.status !== 'complete') {
      const path = existing ? 'partial/' + original : original;
      await mkdir(dirname(resolve(reportDir, path)), { recursive: true });
      await writeFile(resolve(reportDir, path), JSON.stringify({ format: 'oyster-measurements-v1', first, last, records: results.slice(flushed) }));
      artifact = await upload(path);
      await rm(resolve(reportDir, path));
    }
    flushed = last;
    return artifact;
  };
  try {
    await auth.ensureWindow(180000, { signal: campaignSignal });
    baseline = checkState(await adapter.state()); manifest.environment.provider = baseline; manifest.environment.tenant = baseline.tenant;
    manifest.environment.dependencies = { '@sap/cds': baseline.versions.cds, '@sap/cds-oyster': baseline.versions.oyster, '@sap/cds-mtxs': baseline.versions.mtxs, '@cap-js/hana': baseline.versions.hana, autocannon: require('autocannon/package.json').version };
    runID = (await evidence.beginRun({ id, execution: 'cloud', suite: settings.suite, tenant: baseline.tenant, startedAt: manifest.startedAt })).ID;
    manifest.runID = runID;
    onProgress({ runID, completed: 0, planned: runs.length + (settings.suite === 'long' && !settings.filter && !settings.pilot ? settings.repetitions * 2 : 0) });
    await adapter.acquireLease({ owner, ttlMs: 3600000 }); lease = true;
    manifest.environment.runner.dependencies = { autocannon: require('autocannon/package.json').version };
    manifest.environment.sourceHashes = await sourceHashes();
    for (const file of ['package-lock.json', 'build-manifest.json']) {
      try { const bytes = await readFile(resolve(APP_ROOT, file)); const { createHash } = require('node:crypto'); manifest.environment[file === 'package-lock.json' ? 'buildLockSha256' : 'buildManifestSha256'] = createHash('sha256').update(bytes).digest('hex'); if (file === 'build-manifest.json') { const build = JSON.parse(bytes); manifest.environment.runnerDependencyLockSha256 = build.runnerDependencyLockSha256; manifest.environment.rootDependencyLockSha256 = build.rootDependencyLockSha256; } }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (settings.pilot) await auth.ensureWindow(180000, { force: true, signal: campaignSignal });
    const complete = async (run, index, measure) => {
      campaignSignal.throwIfAborted();
      const windowMs = run.scenario.scanCoordination === 'external' ? Number(settings.wholeScanBudgetSeconds || process.env.BENCHMARK_WHOLE_SCAN_BUDGET_SECONDS || 3300) * 1000 : (settings.warmup + settings.duration + 180) * 1000;
      await auth.ensureWindow(windowMs, { signal: campaignSignal });
      await adapter.renewLease({ ttlMs: 3600000 });
      const before = checkState(await adapter.state(), baseline, owner);
      const prefix = String(index + 1).padStart(4, '0') + '-http-rep' + run.repetition;
      const server = { url: baseUrl, headers: auth.headers, state: before, alive: true, cloud: true, runtime: { root: 'cloud-provider' },
        call: type => type === 'metrics-start' ? adapter.metricsStart() : type === 'metrics-stop' ? adapter.metricsStop() : Promise.reject(new Error('Unsupported cloud control')) };
      const records = await measure(run, { server, adapter, chunks, auth, fixture: { ...manifest.fixture, createOffset: index * 32 * 100000 }, settings, rawDir, prefix,
        compactEvidence: true, signal: campaignSignal, reference: adapter, writeStateHash: () => adapter.writeStateHash() });
      try { const after = checkState(await adapter.state(), baseline, owner); records.forEach(record => { record.cloudPostflightState = after; }); }
      catch (error) { records.forEach(record => { record.error = error.message; record.validation = { passed: false }; }); }
      for (const record of records.filter(record => record.validation?.passed !== true)) await writeFile(record.rawFile, JSON.stringify(record, null, 2));
      results.push(...records.map(compactResult));
      onProgress({ runID, completed: results.length });
      for (const file of (await readdir(rawDir)).filter(file => file.startsWith(prefix))) await upload('raw/' + file);
      if (settings.pilot && !manifest.validation.pilotEvidenceReadbackVerified) {
        const artifact = await flushMeasurements();
        assert.ok(artifact, 'Committed pilot measurement batch required');
        const readback = await mkdtemp(resolve(reportDir, '.pilot-readback-'));
        try { await evidence.downloadArtifact({ artifactID: artifact.ID, root: readback }); }
        finally { await rm(readback, { recursive: true, force: true }); }
        manifest.validation.pilotEvidenceReadbackVerified = true;
        manifest.validation.pilotEvidenceReadback = { artifactID: artifact.ID, originalSha256: artifact.originalSha256, checkedAt: new Date().toISOString() };
      }
      if (results.length - flushed >= 20) await flushMeasurements();
      if (records.some(record => record.validation?.passed !== true)) throw new Error(records.find(record => record.error)?.error || 'Cloud case failed');
      await delay(settings.settlingMs ?? 1000, undefined, { signal: campaignSignal });
    };
    for (const [index, run] of runs.entries()) {
      if (repetition !== run.repetition) {
        await auth.ensureWindow(180000, { signal: campaignSignal });
        await adapter.renewLease({ ttlMs: 3600000 });
        await adapter.reset({ signal: campaignSignal });
        manifest.fixture = await adapter.inspectFixture(); assert.equal(manifest.fixture.valid, true, 'Canonical tenant fixture identity');
        manifest.validation.tenantFixtureVerified = true; repetition = run.repetition;
        if (index === 0) {
          await writeFile(resolve(reportDir, 'run.json'), JSON.stringify(compactManifest(manifest)));
          await upload('run.json');
          await rm(resolve(reportDir, 'run.json'));
        }
      }
      await complete(run, index, executeRun);
    }
    if (settings.suite === 'long' && !settings.filter && !settings.pilot) {
      await auth.ensureWindow(3300000, { signal: campaignSignal }); chunks = await cloudScanChunks(adapter, manifest.fixture, { signal: campaignSignal });
      for (let rep = 1; rep <= settings.repetitions; rep++) for (const mode of rep % 2 ? ['native-compute', 'wasm-compute'] : ['wasm-compute', 'native-compute']) {
        const run = { scenario: { ...scenario({ mode, operation: 'scan', scanRows: 50000 }), scanCoordination: 'external', wholeScanRows: manifest.fixture.tables.LargeRows.count }, repetition: rep, transport: 'http', load: { kind: 'vus', value: 1 } };
        manifest.runOrder.push(run); await complete(run, results.length, executeCloudScan);
      }
    }
    await flushMeasurements();
  } catch (error) { fatal = error; manifest.error = error.message; }
  finally {
    try {
    if (lease) { try { await adapter.metricsStop(); } catch { /* A finished case already stopped its sampler. */ } try { await adapter.releaseLease(); lease = false; } catch (error) { manifest.leaseCleanupError = error.message; manifest.error ||= error.message; } }
    manifest.finishedAt = new Date().toISOString();
    manifest.runSummary = { plannedRuns: runs.length + (settings.suite === 'long' && !settings.filter && !settings.pilot ? settings.repetitions * 2 : 0), records: results.length,
      failedRecords: results.filter(record => record.validation?.passed !== true).length, passed: !manifest.error && results.length === runs.length + (settings.suite === 'long' && !settings.filter && !settings.pilot ? settings.repetitions * 2 : 0) && results.every(record => record.validation?.passed === true) };
    Object.assign(manifest, compactManifest(manifest)); delete manifest.runOrder; delete manifest.artifacts;
    if (runID) {
      try {
        if (!suppliedEvidence) evidence = createEvidenceClient(evidenceOptions);
        await auth.ensureWindow(180000);
        const stored = await evidence.listArtifacts(runID);
        for (const file of await readdir(rawDir)) {
          const original = 'raw/' + file;
          if (stored.some(artifact => artifact.path === original && artifact.status === 'complete')) continue;
          const path = stored.some(artifact => artifact.path === original) ? 'partial/' + original : original;
          if (path !== original) {
            await mkdir(dirname(resolve(reportDir, path)), { recursive: true });
            const record = results.find(result => result.rawFile === resolve(reportDir, original));
            if (record) { record.rawFile = resolve(reportDir, path); await writeFile(record.rawFile, JSON.stringify(record, null, 2)); }
            else await copyFile(resolve(reportDir, original), resolve(reportDir, path));
          }
          await upload(path);
        }
        try { await flushMeasurements(); }
        catch (error) { manifest.error ||= error.message; manifest.batchPersistenceError = error.message; manifest.runSummary.passed = false; }
        let final, status;
        for (let attempt = 1; attempt <= 2; attempt++) {
          const interrupted = campaignSignal.aborted;
          if (interrupted) { manifest.error ||= controller.signal.reason?.message || 'Cloud benchmark interrupted'; manifest.runSummary.passed = false; }
          await writeReport(reportDir, manifest, results);
          const folder = 'final-' + attempt; await mkdir(resolve(reportDir, folder), { recursive: true });
          const archive = { format: 'oyster-cloud-report-v1', runID, files: {} };
          for (const file of ['manifest.json', 'results.json', 'results.csv', 'report.md', 'details.md']) {
            await copyFile(resolve(reportDir, file), resolve(reportDir, folder, file));
            const artifact = await upload(folder + '/' + file); archive.files[file] = { ID: artifact.ID, originalSha256: artifact.originalSha256 };
          }
          await writeFile(resolve(reportDir, 'final-report.json'), JSON.stringify(archive));
          await copyFile(resolve(reportDir, 'final-report.json'), resolve(reportDir, folder, 'final-report.json'));
          final = await upload(folder + '/final-report.json');
          if (!interrupted && campaignSignal.aborted) continue;
          status = interrupted ? 'interrupted' : manifest.runSummary.passed ? 'passed' : 'failed'; break;
        }
        // The report archive is committed. Keep signals handled while committing run status.
        committing = true;
        await evidence.finishRun({ runID, status, finalArtifactID: final.ID });
        for (const folder of ['final-1', 'final-2']) await rm(resolve(reportDir, folder), { recursive: true, force: true });
      } catch (error) { manifest.persistenceError = error.message; manifest.runSummary.passed = false; await writeReport(reportDir, manifest, results); fatal ||= error; }
    } else await writeReport(reportDir, manifest, results);
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  }
  return { runID, reportDir, manifest, results, error: fatal?.message };
}

module.exports = { planCloudRuns, pilotSuite, checkState, cloudScanChunks, executeCloudScan, runCloudBenchmark };
if (require.main === module) {
  const settings = parseArgs();
  if (settings.help) console.log('Cloud task: node bench/cloud/run.js --suite short|long --warmup SECONDS --duration SECONDS --repetitions COUNT --filter REGEX');
  else runCloudBenchmark(settings).then(result => { console.log('Cloud run ' + (result.runID || 'unstarted') + ': ' + (result.manifest.runSummary.passed ? 'passed' : 'failed')); if (!result.manifest.runSummary.passed) process.exitCode = 1; }).catch(() => { console.error('Cloud runner setup failed'); process.exitCode = 1; });
}
