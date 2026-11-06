const cds = require('@sap/cds');

function installCallbackDiagnostics() {
  const calls = [];
  for (const name of ['BenchmarkService', 'BenchmarkExtensionService']) {
    const srv = cds.services[name];
    if (!srv) continue;
    srv.prepend(() => srv.on('*', async (req, next) => {
      const sandboxQuery = Boolean(req.query && cds.context?._execPath?.length);
      const started = performance.now();
      const result = await next();
      if (sandboxQuery) calls.push({ event: req.event, target: req.target?.name, query: req.query,
        elapsedMs: performance.now() - started, rows: Array.isArray(result) ? result.length : result ? 1 : 0,
        resultBytes: req.event === 'READ' ? Buffer.byteLength(JSON.stringify(result ?? null)) : 0 });
      return result;
    }));
  }
  return { reset() { calls.length = 0; }, summary() { return { calls: [...calls], count: calls.length,
    resultBytes: calls.reduce((sum, call) => sum + call.resultBytes, 0),
    boundary: 'Successful srvQuery service results serialized by Oyster as JSON; mutation callbacks return empty text',
    timing: 'Diagnostic runtime only, outside performance measurement' }; } };
}

module.exports = { installCallbackDiagnostics };
