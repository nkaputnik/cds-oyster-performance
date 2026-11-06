const { writeFile } = require('node:fs/promises');
const { measureHTTP } = require('./load.js');
async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const result = await measureHTTP(JSON.parse(input));
  await writeFile(process.argv[2], JSON.stringify(result));
  if (result.stats.errors || result.stats.sampleLimitReached) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
