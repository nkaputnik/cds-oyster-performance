const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const packaged = existsSync(resolve(__dirname, 'bench/cloud/run.js'));
const { runCloudBenchmark } = require(packaged ? './bench/cloud/run.js' : '../../bench/cloud/run.js');
const { parseArgs } = require(packaged ? './bench/run.js' : '../../bench/run.js');
const args = process.argv.slice(2);
const pilot = args.includes('--pilot');
const settings = parseArgs(args.filter(argument => argument !== '--pilot'));
settings.pilot = pilot;
if (settings.help) console.log('CF benchmark task: node task.js --suite short|long [--pilot] [--filter REGEX] [--warmup SECONDS] [--duration SECONDS] [--repetitions COUNT]. Requires XSUAA VCAP_SERVICES and BENCHMARK_PROVIDER_URL, BENCHMARK_SUBDOMAIN, BENCHMARK_TENANT_ID. BENCHMARK_NETWORK_PATH defaults to container-to-container (apps.internal root); cf-router requires an HTTPS CF public provider root and includes TLS/router costs.');
else runCloudBenchmark(settings, { onProgress: progress => { if (process.connected) process.send({ type: 'progress', ...progress }, () => {}); } }).then(async result => {
  console.log('Cloud run ' + (result.runID || 'unstarted') + ': ' + (result.manifest.runSummary.passed ? 'passed' : 'failed'));
  if (!result.manifest.runSummary.passed) process.exitCode = 1;
  if (process.env.BENCHMARK_SHARED_RUN === 'true' && result.manifest.runSummary.passed && !result.manifest.persistenceError) await require('node:fs/promises').rm(result.reportDir, { recursive: true, force: true });
  if (process.connected) process.disconnect();
}).catch(() => { console.error('Cloud task setup failed'); process.exitCode = 1; if (process.connected) process.disconnect(); });
