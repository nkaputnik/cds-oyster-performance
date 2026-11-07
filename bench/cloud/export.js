const { mkdir, writeFile, readFile } = require('node:fs/promises');
const { resolve, dirname } = require('node:path');
const { createEvidenceClient } = require('./evidence.js');
async function exportRun({ client, runID, outputRoot }) {
  if (!outputRoot) throw new Error('Explicit evidence output root required');
  await mkdir(outputRoot, { recursive: true });
  const run = await client.getRun(runID), artifacts = await client.listArtifacts(runID), paths = [], pending = [];
  for (const artifact of artifacts) {
    if (artifact.status !== 'complete') { pending.push({ ID: artifact.ID, path: artifact.path, status: artifact.status }); continue; }
    paths.push(await client.downloadArtifact({ artifactID: artifact.ID, root: outputRoot }));
  }
  const final = artifacts.find(artifact => artifact.ID === run.finalArtifact_ID && artifact.status === 'complete');
  if (final) {
    let archive;
    try { archive = JSON.parse(await readFile(resolve(outputRoot, final.path), 'utf8')); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
    if (archive?.format === 'oyster-cloud-report-v1') {
      const prefix = dirname(final.path) === '.' ? '' : dirname(final.path) + '/';
      for (const file of ['manifest.json', 'results.json', 'results.csv', 'report.md', 'details.md']) {
        const report = artifacts.find(artifact => artifact.path === prefix + file && artifact.status === 'complete');
        if (!report) throw new Error('Final archive report artifact missing');
        if (prefix) await client.downloadArtifact({ artifactID: report.ID, root: outputRoot, restorePath: file });
      }
    }
  }
  await writeFile(resolve(outputRoot, 'export.json'), JSON.stringify({ run, artifacts, pending, verifiedArtifacts: paths.length }, null, 2));
  return { run, paths, pending };
}
module.exports = { exportRun };
if (require.main === module) {
  const [runID, outputRoot] = process.argv.slice(2);
  if (!runID || !outputRoot) { console.error('Usage: node bench/cloud/export.js RUN_UUID OUTPUT_ROOT; authenticate with VCAP_SERVICES binding and BENCHMARK_* tenant/provider environment'); process.exitCode = 1; }
  else (async () => {
    const { createTenantAuth } = require('./auth.js');
    const url = process.env.BENCHMARK_EXPORT_URL || process.env.BENCHMARK_PROVIDER_URL;
    const auth = createTenantAuth({ subdomain: process.env.BENCHMARK_SUBDOMAIN, tenantID: process.env.BENCHMARK_TENANT_ID, providerUrl: url, allowPublicProvider: true });
    await auth.ensureWindow(180000);
    await mkdir(resolve(outputRoot), { recursive: true });
    const client = createEvidenceClient({ url: url.replace(/\/+$/, '') + '/benchmark-evidence', headers: async () => { await auth.ensureWindow(180000); return auth.headers; }, scratch: resolve(outputRoot) });
    const result = await exportRun({ client, runID, outputRoot: resolve(outputRoot) }); console.log('Verified ' + result.paths.length + ' completed artifacts; pending ' + result.pending.length);
  })().catch(() => { console.error('Evidence export failed'); process.exitCode = 1; });
}
