const { setTimeout: delay } = require('node:timers/promises');
const { runCloudBenchmark } = require('../../bench/cloud/run.js');
const { createEvidenceClient } = require('../../bench/cloud/evidence.js');
const baseUrl = process.argv[2], reportDir = process.argv[3];
const headers = { authorization: 'Basic ' + Buffer.from('admin:').toString('base64') };
let triggered = false;
const client = createEvidenceClient({ url: baseUrl + '/benchmark-evidence', headers, scratch: reportDir });
const evidence = { ...client,
  beginRun: async manifest => { const run = await client.beginRun(manifest); process.send({ type: 'run', runID: run.ID }); return run; },
  uploadArtifact: async options => {
    if (!triggered && (options.path === 'manifest.json' || /^final-\d+\/manifest.json$/.test(options.path))) { triggered = true; process.send({ type: 'final-upload' }); await delay(100); }
    return client.uploadArtifact(options);
  },
};
runCloudBenchmark({ suite: 'short', repetitions: 1, seed: 42, warmup: 0, duration: 1, filter: '^action/SmallRows/native-empty/direct', settlingMs: 1 },
  { baseUrl, reportDir, evidence, auth: { headers, ensureWindow: async () => headers, assertProvider: () => true } })
  .then(result => { process.send({ type: 'finished', passed: result.manifest.runSummary.passed }); process.disconnect(); })
  .catch(error => { console.error(error.message); process.exitCode = 1; process.disconnect(); });
