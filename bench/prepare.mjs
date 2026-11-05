import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { APP_ROOT, deploy } from './fixture.mjs';
import { scenario } from './scenarios.mjs';
import { sandboxFiles } from './sandbox.mjs';

const appRoots = [APP_ROOT, resolve(APP_ROOT, 'apps/cap')];
const handlerDirectories = ['BenchmarkService', 'BenchmarkExtensionService'];
export async function cleanupRuntime() {
  for (const root of appRoots) {
    for (const name of handlerDirectories)
      await rm(resolve(root, 'srv', name), { recursive: true, force: true });
    await rm(resolve(root, 'benchmark.json'), { force: true });
  }
}

export async function prepareRuntime(input, fixture, { diagnostics = false, signal } = {}) {
  const s = scenario(input);
  const root = s.mode === 'cap-baseline' ? appRoots[1] : APP_ROOT;
  await cleanupRuntime();
  const files = sandboxFiles(s, fixture);
  for (const [path, source] of Object.entries(files)) {
    const target = resolve(root, 'srv', path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source + '\n');
  }
  await writeFile(resolve(root, 'benchmark.json'), JSON.stringify({ scenario: s, fixture, diagnostics, expectedHandlers: Object.keys(files) }, null, 2));
  await deploy(APP_ROOT, { signal });
  return { root, scenario: s, expectedHandlers: Object.keys(files) };
}
