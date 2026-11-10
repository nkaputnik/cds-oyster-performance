const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { open, mkdir, readFile } = require('node:fs/promises');
const { resolve } = require('node:path');
const { APP_ROOT, OYSTER_ROOT, deploy, loadFixture } = require('./fixture.js');
const { executeCommand } = require('./process.js');

const JAVA_ROOT = resolve(APP_ROOT, 'apps/provider-java');
const JAVA_DATABASE = resolve(JAVA_ROOT, 'db-benchmark-java.sqlite');
const SIDECAR_URL = 'http://localhost:4005';
const JAVA_URL = 'http://localhost:8080';
const headers = { Authorization: 'Basic ' + Buffer.from('benchmark:').toString('base64') };
const delay = ms => new Promise(done => setTimeout(done, ms));

async function portAvailable(port) {
  await new Promise((done, reject) => {
    const probe = createServer();
    probe.once('error', () => reject(new Error('Java benchmark needs port ' + port + ' free. Stop the manual server before running.')));
    probe.listen(port, () => probe.close(done));
  });
}

async function startProcess(executable, args, cwd, logPrefix, url, auth, signal) {
  signal?.throwIfAborted();
  const stdoutPath = logPrefix + '.stdout.log', stderrPath = logPrefix + '.stderr.log';
  const stdout = await open(stdoutPath, 'w'), stderr = await open(stderrPath, 'w');
  let child;
  try { child = spawn(executable, args, { cwd, stdio: ['ignore', stdout.fd, stderr.fd] }); }
  finally { await stdout.close(); await stderr.close(); }
  let exit = null, processError, stopping;
  child.once('error', error => { processError = error; });
  child.once('exit', (code, signal) => { exit = { code, signal }; });
  const server = { runtime: { root: cwd }, url, headers: auth, stdoutPath, stderrPath,
    get alive() { return !exit && !processError; }, get exit() { return exit; },
    async call(type) {
      if (!server.alive) throw new Error('Java provider exited; inspect ' + stderrPath);
      const phase = type === 'metrics-start' ? 'start' : type === 'metrics-stop' ? 'stop' : null;
      if (!phase) throw new Error('Unknown Java control request: ' + type);
      const response = await fetch(JAVA_URL + '/__benchmark/metrics/' + phase, {
        method: 'POST', headers: auth, signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error('Java metrics ' + phase + ': HTTP ' + response.status + ' ' + await response.text());
      return response.json();
    },
    stop() {
      stopping ||= (async () => {
        if (!server.alive) return;
        child.kill('SIGTERM');
        for (let i = 0; i < 100 && server.alive; i++) await delay(100);
        if (server.alive) { child.kill('SIGKILL'); await new Promise(done => child.once('exit', done)); }
      })();
      return stopping;
    },
  };
  const abort = () => { void server.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.once('exit', () => signal?.removeEventListener('abort', abort));
  try {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (processError) throw processError;
      if (!server.alive) throw new Error('Java benchmark process exited; inspect ' + stdoutPath + ' and ' + stderrPath);
      try {
        const response = await fetch(url + (auth ? '/__benchmark/status' : '/'), { headers: auth, signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          if (auth) {
            server.state = await response.json();
            if (server.state.hostRuntime !== 'java' || server.state.engine !== 'oyster' || !server.state.annotations?.length)
              throw new Error('Java tenant Oyster handlers are not activated');
          } else await response.arrayBuffer();
          return server;
        }
        await response.arrayBuffer();
      } catch (error) {
        if (error.message === 'Java tenant Oyster handlers are not activated') throw error;
      }
      await delay(200);
    }
    throw new Error('Java benchmark readiness timed out; inspect ' + stdoutPath + ' and ' + stderrPath);
  } catch (error) { await server.stop(); throw error; }
}

async function createJavaRuntime({ logDir, signal }) {
  await portAvailable(4005);
  await portAvailable(8080);
  await mkdir(logDir, { recursive: true });
  const cds = resolve(APP_ROOT, 'node_modules/.bin/cds');
  let sidecar, provider, starts = 0;
  const runtime = {
    async start() {
      provider = await startProcess('java', ['-jar', 'srv/target/provider-java-exec.jar', '--spring.profiles.active=with-mtx', '--debug=false'],
        JAVA_ROOT, resolve(logDir, 'java-' + ++starts), JAVA_URL, headers, signal);
      return provider;
    },
    async reset() {
      if (provider?.alive) throw new Error('Stop Java before resetting its tenant database');
      await deploy({ database: JAVA_DATABASE, signal });
    },
    async stop() { await provider?.stop(); await sidecar?.stop(); },
  };
  async function command(executable, args, cwd, label) {
    const result = await executeCommand(executable, args, { cwd, signal, timeoutMs: 600000,
      captureOutput: true, logPrefix: resolve(logDir, label) });
    if (result.code !== 0) throw new Error(label + ' failed; inspect ' + result.stderrPath + ' and ' + result.stdoutPath);
  }
  try {
    console.log('Building CAP Java provider');
    await command(process.env.BENCHMARK_MAVEN || 'mvn', ['--batch-mode', '--no-transfer-progress', 'package'], JAVA_ROOT, 'java-build');
    await command(cds, ['build', '--profile', 'extension-build'], OYSTER_ROOT, 'extension-build');
    sidecar = await startProcess(process.execPath, [resolve(APP_ROOT, 'node_modules/@sap/cds/bin/serve.js')],
      resolve(JAVA_ROOT, 'mtx/sidecar'), resolve(logDir, 'sidecar'), SIDECAR_URL, undefined, signal);
    await command(cds, ['subscribe', 'benchmark-java', '--to', SIDECAR_URL], JAVA_ROOT, 'tenant-subscribe');
    const archive = await readFile(resolve(OYSTER_ROOT, 'gen/extension.tgz'));
    const response = await fetch(SIDECAR_URL + '/-/cds/extensibility/push', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ extension: archive.toString('base64'), tag: 'oyster-benchmark-extension', tenant: 'benchmark-java' }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    });
    if (!response.ok) throw new Error('Java tenant extension activation: HTTP ' + response.status + ' ' + await response.text());
    runtime.fixture = await loadFixture({ database: JAVA_DATABASE, signal });
    return runtime;
  } catch (error) { await runtime.stop(); throw error; }
}

module.exports = { createJavaRuntime, JAVA_ROOT, JAVA_DATABASE };
