const { createHash } = require('node:crypto');
const { readFile } = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const APP_ROOT = resolve(__dirname, '..');
const DATABASE_PATH = resolve(APP_ROOT, 'db/benchmark.sqlite');
const TABLES = ['SmallRows', 'LargeRows', 'WriteRows', 'LookupRows', 'SideEffectRows'];
async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
async function command(executable, args, cwd = APP_ROOT, { signal } = {}) {
  await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: 30000, killSignal: 'SIGKILL' });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? done() : reject(new Error(executable + ' exited ' + (signal || code) + ': ' + output)));
  });
}
async function deploy(cwd = APP_ROOT, options = {}) {
  await command(resolve(APP_ROOT, 'node_modules/.bin/cds'), ['deploy', '--to', 'sqlite:db/benchmark.sqlite'], cwd, options);
}
function inspectFixture(database = DATABASE_PATH) {
  const db = new DatabaseSync(database, { readOnly: true });
  const tables = {};
  try {
    for (const name of TABLES) {
      const summary = db.prepare('SELECT count(*) AS count, count(DISTINCT ID) AS uniqueKeys, min(ID) AS minID, max(ID) AS maxID, min(value) AS minValue, max(value) AS maxValue, min(length(text)) AS minTextBytes, max(length(text)) AS maxTextBytes FROM perf_' + name).get();
      const sample = db.prepare('SELECT ID, groupNo, value, text FROM perf_' + name + ' ORDER BY ID LIMIT 1000').all();
      if (!summary.count || summary.uniqueKeys !== summary.count)
        throw new Error('CSV data must contain rows with unique keys for ' + name);
      tables[name] = { ...summary, ids: sample.map(r => r.ID), sample };
    }
    const pragmas = {};
    for (const key of ['journal_mode', 'synchronous', 'busy_timeout', 'page_size', 'cache_size']) pragmas[key] = db.prepare('PRAGMA ' + key).all();
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index') AND name LIKE 'perf_%' ORDER BY name").all();
    return { tables, pragmas, schema };
  } finally { db.close(); }
}
async function loadFixture() {
  await deploy();
  const hashes = {};
  for (const name of TABLES) hashes['db/data/perf-' + name + '.csv'] = await hashFile(resolve(APP_ROOT, 'db/data/perf-' + name + '.csv'));
  return { deployedAt: new Date().toISOString(), source: 'CDS model and retained CSV files; cds deploy --to sqlite', ...inspectFixture(), hashes };
}
module.exports = { APP_ROOT, DATABASE_PATH, TABLES, hashFile, command, deploy, inspectFixture, loadFixture };

if (require.main === module) {
  loadFixture().then(fixture => console.log('Deployed rows:', Object.fromEntries(Object.entries(fixture.tables).map(([name, value]) => [name, value.count]))))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
