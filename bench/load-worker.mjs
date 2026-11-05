import { writeFile } from 'node:fs/promises';
import { measureHTTP } from './load.mjs';
let input = '';
for await (const chunk of process.stdin) input += chunk;
const result = await measureHTTP(JSON.parse(input));
await writeFile(process.argv[2], JSON.stringify(result));
if (result.stats.errors || result.stats.sampleLimitReached) process.exitCode = 1;
