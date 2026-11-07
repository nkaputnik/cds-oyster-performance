const { createInterface } = require('node:readline/promises');
const { Writable, Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { mkdir, readFile, rm } = require('node:fs/promises');
const { resolve, relative } = require('node:path');
const defaultUrl = 'https://d034457-oyster-benchmarks.cfapps.eu12-002.hana.ondemand.com';
async function password() {
  if (!process.stdin.isTTY) throw new Error('Run in an interactive terminal for the password prompt');
  const output = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write('Shared benchmark password: ');
  try { return await input.question(''); } finally { input.close(); process.stdout.write('\n'); }
}
function createSharedClient({ url = defaultUrl, username = 'colleague-demo', password }) {
  const origin = new URL(url);
  if (origin.protocol !== 'https:' || origin.origin !== url) throw new Error('Use an HTTPS runner origin without a path or credentials');
  const authorization = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  const fetchAt = async (path, options = {}) => {
    const response = await fetch(url + path, { ...options, headers: { authorization, ...options.headers }, redirect: 'error', signal: AbortSignal.timeout(120000) });
    if (!response.ok) { const message = await response.json().catch(() => ({})); throw new Error('HTTP ' + response.status + ': ' + (message.error || 'Benchmark request failed')); }
    return response;
  };
  return {
    status: async () => (await fetchAt('/status')).json(),
    runs: async () => (await fetchAt('/runs')).json(),
    start: async suite => {
      if (!['short', 'long', 'pilot'].includes(suite)) throw new Error('Choose short, long or pilot');
      const status = await fetchAt('/status', { headers: { 'x-csrf-token': 'Fetch' } });
      await status.body.cancel();
      return (await fetchAt('/runs', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': status.headers.get('x-csrf-token') }, body: JSON.stringify({ suite }) })).json();
    },
    download: async (runID, outputRoot = resolve(__dirname, '../../reports')) => {
      if (!/^[a-f0-9-]{36}$/i.test(runID)) throw new Error('Run UUID required');
      const { files } = await (await fetchAt('/runs/' + runID + '/files')).json();
      const allowed = ['manifest.json', 'results.json', 'results.csv', 'report.md', 'details.md'];
      if (!Array.isArray(files) || files.length !== allowed.length || !allowed.every(name => files.filter(file => file.name === name).length === 1)) throw new Error('Final report is unavailable or incomplete');
      const manifestResponse = await fetchAt('/runs/' + runID + '/files/manifest.json');
      const manifestBytes = Buffer.from(await manifestResponse.arrayBuffer());
      const metadata = files.find(file => file.name === 'manifest.json');
      if (createHash('sha256').update(manifestBytes).digest('hex') !== metadata.sha256) throw new Error('Manifest SHA-256 mismatch');
      const manifest = JSON.parse(manifestBytes);
      if (!/^cloud-[\dTZ-]+$/.test(manifest.id || '') || manifest.runID !== runID) throw new Error('Cloud run identity mismatch');
      const directory = resolve(outputRoot, manifest.id); await mkdir(directory, { recursive: false });
      try {
      await require('node:fs/promises').writeFile(resolve(directory, 'manifest.json'), manifestBytes, { flag: 'wx' });
      for (const file of files.filter(file => file.name !== 'manifest.json')) {
        const destination = resolve(directory, file.name), response = await fetchAt('/runs/' + runID + '/files/' + file.name), hash = createHash('sha256');
        try {
          await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); } }), createWriteStream(destination, { flags: 'wx' }));
          if (hash.digest('hex') !== file.sha256) throw new Error('Report SHA-256 mismatch');
        } catch (error) { await rm(destination, { force: true }); throw error; }
      }
      // Reports are derived from the verified measurements; regenerate portable source links.
      const { writeMarkdownReports } = require('../report.js');
      const results = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
      const sourceRoot = relative(directory, resolve(__dirname, '../../apps/extension/srv')).split('/').map(encodeURIComponent).join('/') + '/';
      await writeMarkdownReports(directory, { ...manifest, reporting: { ...manifest.reporting, sourceRoot } }, results);
      return directory;
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    },
  };
}
async function main(args) {
  let url = defaultUrl, username = 'colleague-demo'; const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') url = args[++i];
    else if (args[i] === '--user') username = args[++i];
    else positional.push(args[i]);
  }
  const [command, value, outputRoot] = positional;
  if (command === '--help' || !command) { console.log('npm run btp -- start short|long|pilot | status | runs | download RUN_UUID [OUTPUT_ROOT] [--url HTTPS_ORIGIN] [--user USERNAME]. Prompts once for the password; no BTP/CF account required.'); return; }
  if (!['start', 'status', 'runs', 'download'].includes(command) || positional.length > (command === 'download' ? 3 : command === 'start' ? 2 : 1)) throw new Error('Invalid command; use --help');
  const client = createSharedClient({ url, username, password: await password() });
  if (command === 'download') { await mkdir(resolve(outputRoot || resolve(__dirname, '../../reports')), { recursive: true }); console.log('Downloaded: ' + await client.download(value, outputRoot)); }
  else console.log(JSON.stringify(await client[command](value), null, 2));
}
module.exports = { createSharedClient, defaultUrl, password };
if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
