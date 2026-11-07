const { writeFile } = require('node:fs/promises');
const { measureHTTP } = require('./load.js');
async function main() {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const result = await measureHTTP({ ...JSON.parse(input), signal: controller.signal });
  if (process.argv[2] === '-') {
    const { stats, probe, failures, generatorResources, protocol, overallRate, notes } = result;
    process.stdout.write(JSON.stringify({ stats, probe, failures, generatorResources, protocol, overallRate, notes }));
  } else await writeFile(process.argv[2], JSON.stringify(result));
  if (result.stats.errors || result.stats.sampleLimitReached || result.stats.cancelled) process.exitCode = 1;
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
}
main().catch(error => {
  const reason = error instanceof SyntaxError ? 'Invalid worker input or JSON response' : String(error.message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2048);
  console.error('HTTP worker failed: ' + error.name + ': ' + reason);
  process.exitCode = 1;
});
