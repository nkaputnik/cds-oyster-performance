const { createHash, createHmac, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { fork } = require('node:child_process');
const { resolve } = require('node:path');
const { createReadStream } = require('node:fs');
const { mkdtemp, rm } = require('node:fs/promises');
const { pipeline } = require('node:stream/promises');
const derive = promisify(scrypt);
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const presets = { short: ['--suite', 'short'], long: ['--suite', 'long'], pilot: ['--suite', 'short', '--pilot', '--warmup', '1', '--duration', '5', '--repetitions', '1'] };
function loadConfig() {
  const services = JSON.parse(process.env.VCAP_SERVICES || '{}');
  return services['user-provided']?.find(service => service.name === process.env.BENCHMARK_LOGIN_SERVICE)?.credentials;
}
function validate(config) {
  if (!config?.username || !/^[a-f0-9]{32}$/.test(config.salt || '') || !/^[a-f0-9]{64}$/.test(config.hash || '')) throw new Error('Shared benchmark login service requires username, salt and hash');
  const origin = new URL(config.publicOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin) throw new Error('Shared benchmark login requires an HTTPS public origin');
}
async function body(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0, chunks = [];
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 1024) { reject(new Error('Request too large')); chunks = []; } else chunks.push(chunk); });
    request.once('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Invalid JSON request')); } });
    request.once('error', reject);
  });
}
function createSharedRunner({ config = loadConfig(), launch = args => fork(resolve(__dirname, 'task.js'), args, { execArgv: [], env: { ...process.env, BENCHMARK_SHARED_RUN: 'true' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }), listRuns, getFiles, download } = {}) {
  validate(config);
  const expected = Buffer.from(config.hash, 'hex'), csrf = createHmac('sha256', expected).update(config.username + ':' + config.publicOrigin).digest('hex');
  let accepted, verifying = false, active = null, last = null, transferring = false;
  const verify = async header => {
    if (typeof header !== 'string' || header.length > 1024 || !/^Basic [A-Za-z0-9+/]+={0,2}$/i.test(header)) return false;
    const digest = createHash('sha256').update(header).digest();
    if (accepted && timingSafeEqual(digest, accepted)) return true;
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8'), separator = decoded.indexOf(':');
    if (decoded.slice(0, separator) !== config.username || separator < 0 || verifying) return false;
    const password = decoded.slice(separator + 1);
    if (!password || password.length > 256) return false;
    verifying = true;
    try { const actual = await derive(password, config.salt, 32); if (!timingSafeEqual(actual, expected)) return false; accepted = digest; return true; }
    finally { verifying = false; }
  };
  const handler = async (req, res) => {
    const headers = { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
    const send = (status, data) => { res.writeHead(status, headers); res.end(JSON.stringify(data)); };
    try {
      if (req.method === 'GET' && req.url === '/health') return send(200, { status: 'up' });
      if (!await verify(req.headers.authorization)) { headers['www-authenticate'] = 'Basic realm="Oyster benchmarks", charset="UTF-8"'; return send(401, { error: 'Shared login required' }); }
      if (req.headers['x-csrf-token'] === 'Fetch') headers['x-csrf-token'] = csrf;
      if (req.method === 'GET' && req.url === '/status') return send(200, { active, last });
      if (req.method === 'POST' && req.url === '/runs') {
        if (req.headers.origin && req.headers.origin !== config.publicOrigin || req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Foreign origin' });
        const token = req.headers['x-csrf-token'];
        if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(csrf))) return send(403, { error: 'Fetch a CSRF token from /status first' });
        if (active || transferring) return send(409, { error: 'Runner busy', active });
        if (req.headers['content-type'] !== 'application/json') return send(415, { error: 'Use application/json' });
        const input = await body(req);
        if (!input || Object.keys(input).length !== 1 || !Object.hasOwn(presets, input.suite)) return send(400, { error: 'Choose suite short, long or pilot; no other options are accepted' });
        if (active || transferring) return send(409, { error: 'Runner busy', active });
        active = { suite: input.suite, startedAt: new Date().toISOString(), runID: null, completed: 0, planned: null };
        let child;
        try { child = launch(presets[input.suite]); } catch (error) { active = null; throw error; }
        child.on('message', message => { if (active && message?.type === 'progress') for (const field of ['runID', 'completed', 'planned']) if (message[field] != null) active[field] = message[field]; });
        const finish = (code, signal) => { if (!active) return; last = { ...active, finishedAt: new Date().toISOString(), status: code === 0 ? 'passed' : 'failed', signal: signal || null }; active = null; };
        child.once('exit', finish); child.once('error', () => finish(1));
        return send(202, { active });
      }
      const fileMatch = new RegExp('^/runs/(' + UUID + ')/files(?:/(manifest.json|results.json|results.csv|report.md|details.md))?$', 'i').exec(req.url);
      if (req.method === 'GET' && (req.url === '/runs' || fileMatch)) {
        if (active || transferring) return send(409, { error: 'Reports are available while the runner is idle; /status gives progress without touching the measured provider' });
        transferring = true;
        try {
          if (req.url === '/runs') return send(200, { runs: await listRuns() });
          const files = await getFiles(fileMatch[1]);
          if (!fileMatch[2]) return send(200, { files });
          const file = files.find(file => file.name === fileMatch[2]);
          if (!file) return send(404, { error: 'Report file unavailable' });
          const root = await mkdtemp('/tmp/oyster-report-');
          try {
            const path = await download(file, root);
            res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="' + file.name + '"', 'x-content-sha256': file.sha256 });
            await pipeline(createReadStream(path), res);
          } finally { await rm(root, { recursive: true, force: true }); }
          return;
        } finally { transferring = false; }
      }
      return send(404, { error: 'Unknown endpoint' });
    } catch (error) {
      if (res.headersSent) return res.destroy();
      send(error.status === 404 ? 404 : /JSON|too large/.test(error.message) ? 400 : 503, { error: 'Benchmark request failed' });
    }
  };
  return handler;
}
module.exports = { createSharedRunner, loadConfig, presets };
