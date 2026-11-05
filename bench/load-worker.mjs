import { readFile, writeFile } from 'node:fs/promises';
import { measureHTTP } from './load.mjs';
const config = JSON.parse(await readFile(process.argv[2], 'utf8'));
const result = await measureHTTP(config);
await writeFile(process.argv[3], JSON.stringify(result) + '\n');
if (result.stats.errors || result.stats.sampleLimitReached) process.exitCode = 1;
