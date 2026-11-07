const { existsSync } = require('node:fs');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { resolve } = require('node:path');
const base = existsSync(resolve(__dirname, 'bench/cloud/auth.js')) ? './bench/cloud/' : '../../bench/cloud/';
const { createTenantAuth } = require(base + 'auth.js');
const { createEvidenceClient } = require(base + 'evidence.js');
function sharedEvidence() {
  const url = process.env.BENCHMARK_PROVIDER_URL;
  const auth = createTenantAuth({ subdomain: process.env.BENCHMARK_SUBDOMAIN, tenantID: process.env.BENCHMARK_TENANT_ID, providerUrl: url, allowPublicProvider: true });
  const client = scratch => createEvidenceClient({ url: url.replace(/\/+$/, '') + '/benchmark-evidence', headers: async () => { await auth.ensureWindow(180000); return auth.headers; }, scratch });
  return {
    listRuns: async () => (await client('/tmp').listRuns()).map(run => { const m = JSON.parse(run.manifest); return { ID: run.ID, id: m.id, suite: m.suite, startedAt: m.startedAt, finishedAt: run.finishedAt, status: run.status }; }),
    getFiles: async runID => {
      const root = await mkdtemp('/tmp/oyster-index-');
      try {
        const api = client(root), run = await api.getRun(runID);
        if (!run.finalArtifact_ID || run.status === 'open') return [];
        const final = await api.getArtifact(run.finalArtifact_ID);
        const path = await api.downloadArtifact({ artifactID: run.finalArtifact_ID, root, restorePath: 'index.json' });
        const index = JSON.parse(await readFile(path, 'utf8'));
        return reportFiles(index, final);
      } finally { await rm(root, { recursive: true, force: true }); }
    },
    download: (file, root) => client(root).downloadArtifact({ artifactID: file.ID, root, restorePath: file.name }),
  };
}
function reportFiles(index, final) {
  if (index.format !== 'oyster-cloud-report-v1' || !index.files) throw new Error('Final report descriptor unavailable');
  const prefix = final.path.slice(0, final.path.lastIndexOf('/') + 1);
  return ['manifest.json', 'results.json', 'results.csv', 'report.md', 'details.md'].map(name => {
    const file = typeof index.files[name] === 'object' ? index.files[name] : index.artifacts?.find(a => a.path === prefix + name);
    if (!file?.ID || !/^[a-f0-9]{64}$/.test(file.originalSha256 || '')) throw new Error('Final report identity missing');
    return { name, ID: file.ID, sha256: file.originalSha256 };
  });
}
module.exports = { sharedEvidence, reportFiles };
