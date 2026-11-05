import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DATABASE_PATH = resolve(APP_ROOT, 'db/benchmark.sqlite');
export const TABLES = ['SmallRows', 'LargeRows', 'WriteRows', 'LookupRows', 'SideEffectRows'];
export async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}
export async function command(executable, args, cwd = APP_ROOT, { signal } = {}) {
  await new Promise((done, reject) => {
    const child = spawn(executable, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal, timeout: 30000, killSignal: 'SIGKILL' });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? done() : reject(new Error(executable + ' exited ' + (signal || code) + ': ' + output)));
  });
}
export async function deploy(cwd = APP_ROOT, options = {}) {
  await command(resolve(APP_ROOT, 'node_modules/.bin/cds'), ['deploy', '--to', 'sqlite:db/benchmark.sqlite'], cwd, options);
}
export function inspectFixture(database = DATABASE_PATH) {
  const db = new DatabaseSync(database, { readOnly: true });
  const tables = {};
  try {
    for (const name of TABLES) {
      const summary = db.prepare('SELECT count(*) AS count, count(DISTINCT ID) AS uniqueKeys, min(ID) AS minID, max(ID) AS maxID, min(value) AS minValue, max(value) AS maxValue, min(length(text)) AS minTextBytes, max(length(text)) AS maxTextBytes FROM perf_' + name).get();
      const sample = db.prepare('SELECT ID, groupNo, value, text FROM perf_' + name + ' ORDER BY ID LIMIT 1000').all();
      if (!summary.count || summary.uniqueKeys !== summary.count)
        throw new Error('CSV data must contain rows with unique keys for ' + name);
      tables[name] = { ...summary, ids: sample.map(r => r.ID), sample: sample.slice(0, 5) };
    }
    const pragmas = {};
    for (const key of ['journal_mode', 'synchronous', 'busy_timeout', 'page_size', 'cache_size']) pragmas[key] = db.prepare('PRAGMA ' + key).all();
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('table', 'index') AND name LIKE 'perf_%' ORDER BY name").all();
    return { tables, pragmas, schema };
  } finally { db.close(); }
}
export async function loadFixture() {
  await deploy();
  const hashes = {};
  for (const name of TABLES) hashes['db/data/perf-' + name + '.csv'] = await hashFile(resolve(APP_ROOT, 'db/data/perf-' + name + '.csv'));
  return { deployedAt: new Date().toISOString(), source: 'CDS model and retained CSV files; cds deploy --to sqlite', ...inspectFixture(), hashes };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await loadFixture();
  console.log('Deployed rows:', Object.fromEntries(Object.entries(fixture.tables).map(([name, value]) => [name, value.count])));
}
