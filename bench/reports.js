const { readFile, readdir } = require('node:fs/promises');
const { resolve } = require('node:path');
const { writeMarkdownReports } = require('./report.js');

const reportsRoot = resolve(__dirname, '../reports');
async function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('npm run report -- --latest | --all | reports/<run-id>');
    return;
  }
  if (args.length !== 1) throw new Error('Choose --latest, --all, or a result directory. Use --help for usage.');
  let directories;
  if (['--latest', '--all'].includes(args[0])) {
    const entries = await readdir(reportsRoot, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries.filter(e => e.isDirectory())) {
      const directory = resolve(reportsRoot, entry.name);
      try {
        const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
        await readFile(resolve(directory, 'results.json'), 'utf8');
        candidates.push({ directory, startedAt: manifest.startedAt || entry.name });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    candidates.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    directories = (args[0] === '--latest' ? candidates.slice(-1) : candidates).map(c => c.directory);
    if (!directories.length) throw new Error('No saved benchmark results found.');
  } else {
    if (args[0].startsWith('--')) throw new Error('Unknown option: ' + args[0]);
    directories = [resolve(args[0])];
  }
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
    const results = JSON.parse(await readFile(resolve(directory, 'results.json'), 'utf8'));
    console.log('Report: ' + await writeMarkdownReports(directory, manifest, results));
  }
}
main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
