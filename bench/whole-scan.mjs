import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATABASE_PATH } from './fixture.mjs';
import { prepareRuntime, cleanupRuntime } from './prepare.mjs';
import { startServer } from './process.mjs';
import { scenario, shuffled } from './scenarios.mjs';
import { cpu } from '../lib/workload.mjs';
import { publicRequest, validateActivation } from './verify.mjs';

export function referenceChunks(database, { rows = 1000000, chunkRows = 50000, iterations = 100 } = {}) {
  const db = new DatabaseSync(database, { readOnly: true });
  const chunks = [];
  try {
    let cursor = db.prepare('SELECT min(ID)-1 AS cursor FROM perf_LargeRows').get().cursor;
    for (let remaining = rows; remaining > 0;) {
      const count = Math.min(remaining, chunkRows);
      let checksum = 0, actual = 0, lastID = cursor;
      for (const row of db.prepare('SELECT ID,value FROM perf_LargeRows WHERE ID>? ORDER BY ID LIMIT ?').iterate(cursor, count)) {
        checksum = (checksum + cpu(row.value, iterations)) & 2147483647; lastID = row.ID; actual++;
      }
      assert.equal(actual, count, 'Whole-scan reference must contain requested rows');
      chunks.push({ cursor, count, checksum, lastID }); cursor = lastID; remaining -= count;
    }
    return chunks;
  } finally { db.close(); }
}

export async function measureWholeScan({ fixture, settings, reportDir, signal, results }) {
  const rows = fixture.tables.LargeRows.count;
  const chunks = referenceChunks(DATABASE_PATH, { rows });
  const scanSignal = AbortSignal.any([signal, AbortSignal.timeout(300000)]);
  for (let repetition = 1; repetition <= settings.repetitions; repetition++) {
    for (const mode of shuffled(['native-compute', 'wasm-compute'], settings.seed + repetition)) {
      scanSignal.throwIfAborted();
      const s = scenario({ mode, operation: 'scan', scanRows: 50000, pageSize: 1000, iterations: 100 });
      const label = 'whole-scan-' + repetition + '-' + mode;
      const rawFile = resolve(reportDir, 'raw', label + '.json');
      const result = { scenario: { ...s, scanCoordination: 'external', wholeScanRows: rows }, repetition,
        transport: 'http', phase: 'warm', load: { kind: 'vus', value: 1 }, rawFile };
      results.push(result);
      let server;
      try {
        const runtime = await prepareRuntime(s, fixture, { signal: scanSignal });
        server = await startServer(runtime, resolve(reportDir, 'logs', label), { signal: scanSignal });
        result.activeState = server.state;
        validateActivation(s, server.state, runtime.expectedHandlers);
        const invoke = async chunk => {
          const response = await publicRequest(server, { method: 'POST', path: '/benchmark/scan',
            headers: { 'Content-Type': 'application/json' }, body: { cursor: chunk.cursor, count: chunk.count, pageSize: 1000 } }, { signal: scanSignal });
          assert.equal(response.status, 200, 'Bounded scan response status');
          assert.equal(response.body.value, chunk.checksum, 'Bounded scan checksum');
          return { ...chunk, durationMs: response.durationMs, status: response.status, result: response.body.value };
        };
        await invoke(chunks[0]);
        await server.call('metrics-start');
        const started = performance.now();
        result.invocations = [];
        for (const chunk of chunks) result.invocations.push(await invoke(chunk));
        result.wholeScanElapsedSeconds = (performance.now() - started) / 1000;
        result.resources = await server.call('metrics-stop');
        const durations = result.invocations.map(item => item.durationMs).sort((a, b) => a - b);
        const p = fraction => durations[Math.ceil(durations.length * fraction) - 1];
        result.stats = { samples: chunks.length, successes: chunks.length, errors: 0, droppedIterations: 0,
          meanMs: durations.reduce((sum, value) => sum + value, 0) / durations.length, p50Ms: p(.5), p95Ms: p(.95), p99Ms: p(.99),
          successfulRps: chunks.length / result.wholeScanElapsedSeconds, elapsedSeconds: result.wholeScanElapsedSeconds };
        result.validation = { passed: true, handlerExecuted: true, rows, invocations: chunks.length, everyChecksumVerified: true };
        console.log(mode + ': whole table in ' + result.wholeScanElapsedSeconds.toFixed(3) + ' s');
      } catch (error) { result.error = error.message; result.validation = { passed: false }; }
      finally {
        if (server) await server.stop();
        await cleanupRuntime();
        await writeFile(rawFile, JSON.stringify(result, null, 2));
      }
    }
  }
}
