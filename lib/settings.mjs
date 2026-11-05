import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import cds from '@sap/cds';

export function settings() {
  try { return JSON.parse(readFileSync(resolve(cds.root, 'benchmark.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { scenario: { mode: 'oyster-idle', iterations: 0, callbacks: 0, access: 'service', hook: false }, fixture: {} };
  }
}

export function workInput(data, config) {
  const lookup = config.fixture.tables?.LookupRows;
  const effect = config.fixture.tables?.SideEffectRows;
  return { seed: data.seed ?? data.value ?? 7, iterations: data.iterations ?? config.scenario.iterations,
    calls: data.calls ?? config.scenario.callbacks,
    lookupID: data.lookupID ?? lookup?.ids[0], effectID: data.effectID ?? effect?.ids[0] };
}
