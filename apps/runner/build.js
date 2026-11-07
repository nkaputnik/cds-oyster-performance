const { cp, mkdir, readFile, readdir, writeFile, rm } = require('node:fs/promises');
const { resolve, relative } = require('node:path');
const { createHash } = require('node:crypto');
const root = resolve(__dirname, '../..');
async function buildRunner(destination) {
  if (!destination) throw new Error('Explicit runner build destination required');
  destination = resolve(destination);
  if (destination === root || !relative(root, destination).startsWith('..') && !relative(root, destination).startsWith('gen/')) throw new Error('Runner output must be outside source or under gen/');
  await mkdir(destination, { recursive: true });
  if ((await readdir(destination)).length) {
    let previous;
    try { previous = JSON.parse(await readFile(resolve(destination, 'build-manifest.json'))); } catch { throw new Error('Existing runner output requires its build manifest'); }
    if (previous.format !== 'oyster-runner-build-v1') throw new Error('Existing output is not an owned runner build');
    for (const entry of await readdir(destination)) await rm(resolve(destination, entry), { recursive: true, force: true });
  }
  const inputs = ['bench', 'apps/provider/srv', 'apps/provider/db/schema.cds', 'apps/extension/srv'];
  for (const path of inputs) await cp(resolve(root, path), resolve(destination, path), { recursive: true });
  for (const file of ['package.json', 'task.js', 'stage.js', 'shared.js', 'shared-evidence.js', 'Procfile']) await cp(resolve(__dirname, file), resolve(destination, file));
  const sourceHashes = {};
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else sourceHashes[relative(destination, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
    }
  }
  await visit(destination);
  let rootDependencyLockSha256 = null, runnerDependencyLockSha256 = null;
  try { rootDependencyLockSha256 = createHash('sha256').update(await readFile(resolve(root, 'package-lock.json'))).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { const lock = await readFile(resolve(__dirname, 'package-lock.json')); runnerDependencyLockSha256 = createHash('sha256').update(lock).digest('hex'); await writeFile(resolve(destination, 'package-lock.json'), lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  await writeFile(resolve(destination, 'build-manifest.json'), JSON.stringify({ format: 'oyster-runner-build-v1', sourceHashes, rootDependencyLockSha256, runnerDependencyLockSha256 }, null, 2));
  return destination;
}
module.exports = { buildRunner };
if (require.main === module) buildRunner(process.argv[2]).then(path => console.log(path)).catch(error => { console.error(error.message); process.exitCode = 1; });
