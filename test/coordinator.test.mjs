import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('verification CLI help exits without needing a fixture', async () => {
  const result = await promisify(execFile)(process.execPath, [resolve(import.meta.dirname, '../bench/verify.mjs'), '--help']);
  assert.match(result.stdout, /npm run verify/);
  assert.doesNotMatch(result.stderr, /Error:|ERR_/);
});

test('short and long protocols cover every question within their timing budgets', async () => {
  const { parseArgs, planRuns } = await import('../bench/run.mjs');
  const short = parseArgs([]), long = parseArgs(['--suite', 'long']);
  assert.equal(short.suite, 'short');
  assert.equal(short.transport, 'http');
  assert.equal(short.repetitions, 1);
  assert.equal(long.repetitions, 3);
  for (const settings of [short, long]) {
    const runs = planRuns(settings);
    assert.deepEqual(runs, planRuns(settings));
    assert.ok(runs.some(r => r.load.value === 32));
    assert.ok(runs.some(r => r.scenario.hook && r.scenario.mode === 'wasm-compute-read'));
    assert.ok(runs.some(r => r.scenario.operation === 'scan'));
    assert.ok(runs.some(r => r.scenario.table === 'LargeRows' && r.scenario.operation === 'read'));
    for (const operation of ['create', 'update', 'read', 'action']) {
      const cases = runs.filter(r => r.scenario.operation === operation && r.load.value === 1 && !r.scenario.hook);
      for (const mode of ['cap-baseline', 'native-empty', 'wasm-empty', 'native-compute', 'wasm-compute', 'native-compute-read', 'wasm-compute-read', 'native-compute-write', 'wasm-compute-write'])
        assert.ok(cases.some(r => r.scenario.mode === mode), operation + ' ' + mode);
    }
    const allowance = runs.length * (settings.warmup + settings.duration + 5) + (settings.suite === 'long' ? 300 : 0);
    assert.ok(allowance < settings.budgetSeconds, 'timing includes five seconds per test for checks');
    const batches = runs.filter((run, i) => i === 0 || run.repetition !== runs[i - 1].repetition || (run.scenario.mode === 'cap-baseline') !== (runs[i - 1].scenario.mode === 'cap-baseline'));
    assert.equal(batches.length, 2 * settings.repetitions);
  }
  assert.throws(() => parseArgs(['--suite', 'full']), /suite/);
  assert.throws(() => parseArgs(['--duration', '0']), /duration/);
  assert.throws(() => parseArgs(['--unknown']), /Unknown/);
});

test('owned server waits for readiness and rejects IPC errors without retrying', async () => {
  const { startServer } = await import('../bench/process.mjs');
  const root = await mkdtemp(resolve(import.meta.dirname, '../.process-test-'));
  try {
    const entry = resolve(root, 'server.cjs');
    await writeFile(entry, `const http=require('node:http');
      const server=http.createServer((req,res)=>res.end('ready'));
      process.on('message', m=>{
        if(m.type==='shutdown') server.close(()=>process.exit(0));
        else process.send(m.type==='fail'?{token:m.token,error:{message:'deliberate failure',code:409}}:{token:m.token,value:m.options});
      });
      setTimeout(()=>server.listen(0,'127.0.0.1',()=>process.send({type:'ready',url:'http://127.0.0.1:'+server.address().port,state:{plugins:[]}})),50);`);
    const server = await startServer({ root }, root, { entry, startupTimeoutMs: 2000 });
    assert.equal(await (await fetch(server.url)).text(), 'ready');
    assert.deepEqual(await server.call('echo', { value: 3 }), { value: 3 });
    await assert.rejects(server.call('fail'), /deliberate failure/);
    await server.stop();
    assert.equal(server.alive, false);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('exit before readiness reports the owned log and does not leave a child', async () => {
  const { startServer } = await import('../bench/process.mjs');
  const root = await mkdtemp(resolve(import.meta.dirname, '../.process-test-'));
  try {
    const entry = resolve(root, 'server.cjs');
    await writeFile(entry, `console.error('startup failure'); process.exit(7);`);
    await assert.rejects(startServer({ root }, root, { entry }), /7.*stderr/s);
    assert.match(await readFile(resolve(root, 'server.stderr.log'), 'utf8'), /startup failure/);
  } finally { await rm(root, { force: true, recursive: true }); }
});

test('a failed correctness preflight is recorded once and cannot proceed to warm measurement', async () => {
  const { executeRun, parseArgs } = await import('../bench/run.mjs');
  const { scenario } = await import('../bench/scenarios.mjs');
  const root = await mkdtemp(resolve(import.meta.dirname, '../.coordinator-test-'));
  const calls = [];
  const server = { state: { plugins: [], engine: null, annotations: [] }, runtime: { expectedHandlers: [] }, alive: true, url: 'http://127.0.0.1:1',
    call: async type => { calls.push(type); throw new Error('preflight failure'); } };
  const fixture = { tables: {} };
  try {
    const results = await executeRun({ scenario: scenario(), repetition: 1, transport: 'http', load: { kind: 'vus', value: 1 } },
      { server, fixture, settings: parseArgs(['--suite', 'short']), rawDir: root, prefix: 'test', signal: AbortSignal.abort(new Error('preflight failure')) });
    assert.deepEqual(calls, []);
    assert.equal(results.length, 1);
    assert.equal(results[0].phase, 'warm');
    assert.equal(results[0].stats.errors, null);
    assert.equal(results[0].stats.meanMs, null);
    assert.match(results[0].error, /preflight failure/);
    assert.equal(results[0].validation.passed, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('external CPU measurement preserves the command result and process CPU time', async () => {
  const { executeCommand } = await import('../bench/process.mjs');
  const root = await mkdtemp(resolve(import.meta.dirname, '../.process-test-'));
  try {
    const result = await executeCommand(process.execPath, ['-e', 'const until=Date.now()+300; while(Date.now()<until) Math.sqrt(Math.random());'],
      { logPrefix: resolve(root, 'cpu'), measureCpu: true });
    assert.equal(result.code, 0);
    assert.ok(result.clientCpuPercent > 0);
    assert.match(await readFile(result.stderrPath, 'utf8'), /user/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
