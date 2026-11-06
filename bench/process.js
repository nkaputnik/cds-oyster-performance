const { fork, spawn } = require('node:child_process');
const { open, mkdir, readFile, access } = require('node:fs/promises');
const { resolve } = require('node:path');
const { APP_ROOT } = require('./fixture.js');

const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));

async function startServer(runtime, logDir, { entry = resolve(APP_ROOT, 'node_modules/@sap/cds/bin/serve.js'),
  startupTimeoutMs = 30000, signal, diagnostics = false } = {}) {
  signal?.throwIfAborted();
  await mkdir(logDir, { recursive: true });
  const stdoutPath = resolve(logDir, 'server.stdout.log'), stderrPath = resolve(logDir, 'server.stderr.log');
  const stdout = await open(stdoutPath, 'w'), stderr = await open(stderrPath, 'w');
  let child;
  try { child = fork(entry, [], { cwd: runtime.root, env: { ...process.env, BENCHMARK_DIAGNOSTICS: diagnostics ? '1' : '0' }, stdio: ['ignore', stdout.fd, stderr.fd, 'ipc'], execArgv: [] }); }
  finally { await stdout.close(); await stderr.close(); }
  const pending = new Map();
  let sequence = 0, exit = null, stopping;
  let readyResolve, readyReject;
  const ready = new Promise((done, reject) => { readyResolve = done; readyReject = reject; });
  const server = { child, runtime, stdoutPath, stderrPath, url: null, state: null,
    get alive() { return child.exitCode === null && child.signalCode === null && exit === null; },
    get exit() { return exit; },
    call(type, options, { timeoutMs = 120000 } = {}) {
      if (!server.alive || !child.connected) return Promise.reject(new Error('Owned server is unavailable; ' + stderrPath));
      const token = ++sequence;
      return new Promise((done, reject) => {
        const timer = setTimeout(() => { pending.delete(token); reject(new Error(type + ' IPC timed out; ' + stderrPath)); }, timeoutMs);
        pending.set(token, { done, reject, timer });
        child.send({ type, token, options }, error => {
          if (error && pending.delete(token)) { clearTimeout(timer); reject(error); }
        });
      });
    },
    async stop() {
      if (stopping) return stopping;
      stopping = (async () => {
        if (!server.alive) return;
        if (child.connected) child.send({ type: 'shutdown', token: ++sequence }, () => {});
        for (let i = 0; i < 50 && server.alive; i++) await delay(100);
        if (server.alive) child.kill('SIGTERM');
        for (let i = 0; i < 10 && server.alive; i++) await delay(100);
        if (server.alive) child.kill('SIGKILL');
        if (server.alive) await new Promise(done => child.once('exit', done));
      })();
      return stopping;
    },
  };
  const abort = () => { readyReject(signal.reason || new Error('Interrupted')); void server.stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  child.on('message', message => {
    if (message.type === 'ready') { server.url = message.url; server.state = message.state; readyResolve(server); return; }
    const request = pending.get(message.token);
    if (!request) return;
    pending.delete(message.token); clearTimeout(request.timer);
    if (message.error) { const error = new Error(message.error.message); error.code = message.error.code; request.reject(error); }
    else request.done(message.value);
  });
  child.on('error', error => { readyReject(error); });
  child.on('exit', (code, exitSignal) => {
    exit = { code, signal: exitSignal };
    const error = new Error('Owned server exited ' + (exitSignal || code) + '; stderr: ' + stderrPath);
    readyReject(error);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
    signal?.removeEventListener('abort', abort);
  });
  const timer = setTimeout(() => readyReject(new Error('Server readiness timed out; stderr: ' + stderrPath)), startupTimeoutMs);
  try { return await ready; }
  catch (error) { await server.stop(); throw error; }
  finally { clearTimeout(timer); }
}

async function executeCommand(executable, args, { cwd = APP_ROOT, env = {}, logPrefix, signal, timeoutMs = 180000, measureCpu = false, input } = {}) {
  signal?.throwIfAborted();
  const stdoutPath = logPrefix + '.stdout.log', stderrPath = logPrefix + '.stderr.log';
  const stdout = await open(stdoutPath, 'w'), stderr = await open(stderrPath, 'w');
  const started = performance.now();
  let timerExecutable;
  if (measureCpu) { try { await access('/usr/bin/time'); timerExecutable = '/usr/bin/time'; } catch { /* CPU remains unavailable. */ } }
  const grouped = process.platform !== 'win32';
  let child;
  try { child = spawn(timerExecutable || executable, timerExecutable ? ['-p', executable, ...args] : args,
    { cwd, env: { ...process.env, ...env }, stdio: [input === undefined ? 'ignore' : 'pipe', stdout.fd, stderr.fd], detached: grouped }); }
  finally { await stdout.close(); await stderr.close(); }
  if (input !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  return new Promise((done, reject) => {
    let terminationError, killTimer;
    const killOwned = exitSignal => {
      try { if (grouped) process.kill(-child.pid, exitSignal); else child.kill(exitSignal); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    };
    const terminate = error => {
      terminationError = error; killOwned('SIGTERM');
      killTimer = setTimeout(() => killOwned('SIGKILL'), 1000);
    };
    const abort = () => terminate(signal.reason || new Error('Interrupted'));
    const timer = setTimeout(() => terminate(new Error(executable + ' timed out; ' + stderrPath)), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    const clean = () => { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort); };
    child.once('error', error => { clean(); reject(error); });
    child.once('close', async (code, exitSignal) => {
      clean();
      if (terminationError) reject(terminationError);
      else {
        const elapsedSeconds = (performance.now() - started) / 1000;
        let clientCpuPercent = null, cpuSeconds = null, resourceElapsedSeconds = null;
        if (timerExecutable) {
          const text = await readFile(stderrPath, 'utf8');
          const number = name => { const matches = [...text.matchAll(new RegExp('^' + name + '\\s+([0-9.]+)\\s*$', 'gm'))]; return matches.length ? Number(matches.at(-1)[1]) : null; };
          const user = number('user'), system = number('sys'), real = number('real');
          if (user !== null && system !== null && real > 0) { cpuSeconds = user + system; resourceElapsedSeconds = real; clientCpuPercent = cpuSeconds / real * 100; }
        }
        done({ code, signal: exitSignal, elapsedSeconds, stdoutPath, stderrPath, clientCpuPercent, cpuSeconds, resourceElapsedSeconds,
          clientCpuNote: clientCpuPercent === null ? 'Generator CPU was unavailable.' : 'User plus system CPU from /usr/bin/time -p divided by its wall time; 100% equals one core, with 0.01-second timing precision.' });
      }
    });
  });
}

module.exports = { startServer, executeCommand };
