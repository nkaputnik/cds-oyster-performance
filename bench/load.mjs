import autocannon from 'autocannon';
import { requestFor } from './requests.mjs';

function summary(values) {
  if (!values.length) return { meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  const meanMs = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { meanMs, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) };
}
export async function measureHTTP({ url, scenario, fixture, load, seconds, phase = 'measure', probeRate = 0 }) {
  const rawDurationsMs = [], probeDurationsMs = [], failures = [];
  let successes = 0, statusErrors = 0, nextClient = 0, samplesCapped = false;
  let probeAttempts = 0, probeErrors = 0, probeBusy = false, probeDropped = 0;
  const pendingProbes = new Set();
  const connections = load.value;
  const offset = phase === 'warmup' ? 0 : 5000000;
  const maximumSamples = 5000000;
  const sample = (values, duration) => {
    if (values.length >= maximumSamples) { samplesCapped = true; return; }
    values.push(duration);
  };
  const started = performance.now();
  const probe = async () => {
    if (probeBusy) { probeDropped++; return; }
    probeBusy = true; probeAttempts++;
    const begin = performance.now();
    try {
      const response = await fetch(url + '/benchmark/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      if (response.status === 200) sample(probeDurationsMs, performance.now() - begin);
      else probeErrors++;
    } catch { probeErrors++; }
    finally { probeBusy = false; }
  };
  const launchProbe = () => { const job = probe(); pendingProbes.add(job); job.finally(() => pendingProbes.delete(job)); };
  const probeTimer = probeRate ? setInterval(launchProbe, 1000 / probeRate) : null;
  if (probeRate) launchProbe();
  let result;
  try {
    result = await new Promise((done, reject) => autocannon({
      url, connections, pipelining: 1, duration: seconds, timeout: 5,
      excludeErrorStats: true,
      setupClient(client) {
        const vu = ++nextClient;
        let iteration = 0, expectedStatus = 200;
        client.setRequests([{
          setupRequest(request) {
            let active = scenario;
            if (scenario.mixed) {
              const operation = iteration % 10 < 7 ? 'read' : iteration % 10 === 7 ? 'create' : iteration % 10 === 8 ? 'update' : 'action';
              active = { ...scenario, operation, table: operation === 'read' ? (scenario.readTable || 'SmallRows') : 'WriteRows' };
            }
            const next = requestFor(active, fixture, { vu, iteration: offset + iteration++ });
            expectedStatus = next.expectedStatus;
            return { ...request, method: next.method, path: next.path, headers: next.headers, body: next.body === undefined ? undefined : JSON.stringify(next.body) };
          },
        }]);
        client.on('response', (status, bytes, durationMs) => {
          if (status === expectedStatus) { successes++; sample(rawDurationsMs, durationMs); }
          else {
            statusErrors++;
            if (failures.length < 10) failures.push({ status, expectedStatus, durationMs });
          }
        });
      },
    }, (error, value) => error ? reject(error) : done(value)));
  } finally { if (probeTimer) clearInterval(probeTimer); await Promise.all(pendingProbes); }
  const elapsedSeconds = (performance.now() - started) / 1000;
  const errors = statusErrors + result.errors;
  const completed = successes + errors;
  const rate = count => count / elapsedSeconds;
  return {
    stats: { samples: completed, successes, errors, droppedIterations: null,
      ...summary(rawDurationsMs), successfulRps: rate(successes), completedRps: rate(completed), offeredRps: null,
      elapsedSeconds, sampleLimitReached: samplesCapped },
    probe: { attempts: probeAttempts, errors: probeErrors, droppedIterations: probeDropped, ...summary(probeDurationsMs) },
    rawDurationsMs, failures, generator: result,
    notes: ['Uncorrected successful HTTP response durations preserve sub-millisecond precision.',
      'Autocannon does not expose scheduled dropped arrivals; droppedIterations and offeredRps remain unavailable.',
      ],
  };
}
