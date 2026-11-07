const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');

function readSpecification(scenario, request) {
  const url = new URL(request.path, 'http://benchmark');
  const shape = scenario.queryShape || 'page';
  const specification = { table: scenario.table, shape, rows: Number(url.searchParams.get('$top') || scenario.rows), offset: Number(url.searchParams.get('$skip') || 0) };
  if (shape === 'key') { specification.ID = Number(url.pathname.match(/\((\d+)\)$/)?.[1]); specification.rows = 1; }
  if (shape === 'range') {
    const match = url.searchParams.get('$filter')?.match(/^ID ge (\d+) and ID le (\d+)$/);
    specification.startID = Number(match?.[1]); specification.endID = Number(match?.[2]);
  }
  if (shape === 'non-indexed') specification.groupNo = Number(url.searchParams.get('$filter')?.match(/^groupNo eq (\d+)$/)?.[1]);
  return specification;
}
function createCloudFixture({ baseUrl, headers }) {
  const endpoint = new URL(baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new Error('Cloud fixture requires an HTTP provider URL without embedded credentials');
  if (!headers || !['object', 'function'].includes(typeof headers)) throw new Error('Authenticated cloud headers required');
  const base = endpoint.href.replace(/\/+$/, '').replace(/\/benchmark-admin$/, '') + '/benchmark-admin';
  let lease;
  async function api(action, data = {}, { signal } = {}) {
    const cached = typeof headers === 'function' ? await headers() : headers;
    const response = await fetch(base + '/' + action, { method: 'POST', redirect: 'error',
      headers: { ...cached, 'content-type': 'application/json' }, body: JSON.stringify(data),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
    if (!response.ok) {
      const error = new Error('Cloud fixture ' + action + ' failed with HTTP ' + response.status);
      error.status = response.status; await response.body?.cancel(); throw error;
    }
    return JSON.parse((await response.json()).value);
  }
  const token = () => ({ leaseToken: lease?.token });
  async function reset({ signal, pollMs = 250 } = {}) {
    assert.ok(Number.isInteger(pollMs) && pollMs >= 1 && pollMs <= 10000, 'Bounded reset polling interval required');
    let job = await api('reset', token(), { signal });
    while (['queued', 'running'].includes(job.status)) {
      await delay(pollMs, undefined, { signal });
      job = await api('resetStatus', { ...token(), jobID: job.ID }, { signal });
    }
    if (job.status !== 'succeeded' || !job.after?.valid) throw Object.assign(new Error('Cloud fixture reset failed: ' + (job.error || job.status)), { job });
    for (const [name, table] of Object.entries(job.after.tables)) {
      assert.equal(table.canonicalHash, job.after.sources[name].canonicalHash, 'Restored fixture identity for ' + name);
      assert.equal(table.count, job.after.sources[name].count, 'Restored fixture count for ' + name);
    }
    return job;
  }
  return {
    inspectFixture: () => api('inspectFixture'),
    readReference: (scenario, fixture, request) => api('readReference', { specification: JSON.stringify(readSpecification(scenario, request)) }),
    scanReference: scenario => api('scanReference', { specification: JSON.stringify({ scanRows: scenario.scanRows, iterations: scenario.iterations }) }),
    writeStateHash: () => api('writeStateHash'), state: () => api('state'),
    acquireLease: async ({ owner, ttlMs = 300000 } = {}) => (lease = await api('acquireLease', { owner, ttlMs })),
    renewLease: async ({ ttlMs = 300000 } = {}) => (lease = await api('renewLease', { ...token(), ttlMs })),
    releaseLease: async () => { const result = await api('releaseLease', token()); lease = undefined; return result; },
    metricsStart: () => api('metricsStart', token()), metricsStop: () => api('metricsStop', token()), reset,
  };
}
module.exports = { createCloudFixture };
