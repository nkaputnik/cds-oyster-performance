const autocannon = require('autocannon');
const { requestFor } = require('./requests.js');
const { ResourceSampler } = require('./resources.js');

function summary(values) {
  if (!values.length) return { meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null };
  const meanMs = values.reduce((sum, value) => sum + value, 0) / values.length;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = fraction => sorted[Math.ceil(sorted.length * fraction) - 1];
  return { meanMs, p50Ms: percentile(.5), p95Ms: percentile(.95), p99Ms: percentile(.99) };
}
async function measureHTTP({ url, scenario, fixture, load, seconds, phase = 'measure', probeRate = 0, headers = {}, signal, collectResources = false, overallRate }) {
  if (overallRate !== undefined && (!Number.isSafeInteger(overallRate) || overallRate < 1)) throw new Error('Positive integer pilot rate required');
  signal?.throwIfAborted();
  const sampler = collectResources ? new ResourceSampler().start() : null;
  const rawDurationsMs = [], probeDurationsMs = [], failures = [];
  let successes = 0, acceptedRequests = 0, expectedRejections = 0, statusErrors = 0, nextClient = 0, samplesCapped = false;
  let probeAttempts = 0, probeErrors = 0, probeBusy = false, probeDropped = 0;
  const pendingProbes = new Set();
  const connections = load.value;
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
      const response = await fetch(url + '/benchmark/probe', { method: 'POST', redirect: 'error', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
      await response.arrayBuffer();
      if (response.status === 200) sample(probeDurationsMs, performance.now() - begin);
      else probeErrors++;
    } catch { probeErrors++; }
    finally { probeBusy = false; }
  };
  const launchProbe = () => { const job = probe(); pendingProbes.add(job); job.finally(() => pendingProbes.delete(job)); };
  const probeTimer = probeRate ? setInterval(launchProbe, 1000 / probeRate) : null;
  if (probeRate) launchProbe();
  let result, active, generatorResources;
  const abort = () => active?.stop();
  try {
    result = await new Promise((done, reject) => { active = autocannon({
      url, connections, pipelining: 1, duration: seconds, timeout: 5, ...(overallRate ? { overallRate } : {}),
      excludeErrorStats: true,
      setupClient(client) {
        const vu = ++nextClient;
        let iteration = 0, expectedStatus = 200, validRejection = false;
        // Autocannon otherwise sends into a socket whose response announces closure.
        const send = client._doRequest;
        client._doRequest = function () {
          if (!this.conn.writableEnded) send.call(this);
        };
        client.on('headers', response => {
          if (!response.shouldKeepAlive) client.conn.end();
        });
        // With pipelining: 1, a new request replaces any unmatched request from a closed socket.
        client.on('request', () => client.pipelinedRequests.clear());
        client.setRequests([{
          onResponse(status, body) {
            validRejection = false;
            if (expectedStatus === 400 && status === 400) {
              try { validRejection = JSON.parse(body).error?.message === 'Amount exceeds limit'; } catch { /* Invalid error bodies fail the workload. */ }
            }
          },
          setupRequest(request) {
            let active = scenario;
            if (scenario.mixed) {
              const operation = iteration % 10 < 7 ? 'read' : iteration % 10 === 7 ? 'create' : iteration % 10 === 8 ? 'update' : 'action';
              active = { ...scenario, operation, table: operation === 'read' ? (scenario.readTable || 'SmallRows') : 'WriteRows' };
            }
            const next = requestFor(active, fixture, { vu, phase, iteration: iteration++, clients: connections });
            expectedStatus = next.expectedStatus;
            return { ...request, method: next.method, path: next.path, headers: { ...headers, ...next.headers }, body: next.body === undefined ? undefined : JSON.stringify(next.body) };
          },
        }]);
        client.on('response', (status, bytes, durationMs) => {
          if (status === expectedStatus && (expectedStatus !== 400 || validRejection)) {
            successes++;
            if (expectedStatus === 400) expectedRejections++; else acceptedRequests++;
            sample(rawDurationsMs, durationMs);
          }
          else {
            statusErrors++;
            if (failures.length < 10) failures.push({ status, expectedStatus, durationMs });
          }
        });
      },
    }, (error, value) => error ? reject(error) : done(value)); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort(); });
  } finally { if (probeTimer) clearInterval(probeTimer); await Promise.all(pendingProbes); signal?.removeEventListener('abort', abort); generatorResources = sampler?.stop(); }
  const elapsedSeconds = (performance.now() - started) / 1000;
  const errors = statusErrors + result.errors;
  const completed = successes + errors;
  const rate = count => count / elapsedSeconds;
  return {
    stats: { samples: completed, successes, acceptedRequests, expectedRejections, errors, droppedIterations: null,
      ...summary(rawDurationsMs), successfulRps: rate(successes), completedRps: rate(completed), offeredRps: overallRate || null,
      elapsedSeconds, sampleLimitReached: samplesCapped, ...(signal?.aborted ? { cancelled: true } : {}) },
    probe: { attempts: probeAttempts, errors: probeErrors, droppedIterations: probeDropped, ...summary(probeDurationsMs) },
    rawDurationsMs, failures, generator: result, ...(overallRate ? { protocol: 'rate-limited-pilot', overallRate } : {}), ...(generatorResources ? { generatorResources } : {}),
    notes: ['Durations include accepted requests and exact expected business rejections; unrelated errors are excluded.',
      overallRate ? 'Rate-limited setup pilot; offeredRps records the configured rate cap. Scheduled dropped arrivals remain unavailable.' : 'Autocannon does not expose scheduled dropped arrivals; droppedIterations and offeredRps remain unavailable.',
      ],
  };
}

module.exports = { measureHTTP };
