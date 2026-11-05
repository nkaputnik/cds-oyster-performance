import cds from '@sap/cds';
import { createRequire } from 'node:module';
import { settings } from './lib/settings.mjs';
import { ResourceSampler } from '../../bench/resources.mjs';
import { installCallbackDiagnostics } from './lib/diagnostics.mjs';

const require = createRequire(import.meta.url);
const config = settings();
const sampler = new ResourceSampler();
const queries = [];

function state() {
  const plugins = Object.keys(cds.env.plugins || {});
  const annotations = [];
  for (const [name, definition] of Object.entries(cds.model?.definitions || {}))
    for (const handler of definition['@extension.code'] || []) annotations.push({ name, phase: handler.phase, event: handler.event });
  const oyster = plugins.includes('@sap/cds-oyster');
  const profile = oyster ? require('@sap/cds-oyster/lib/profile') : null;
  return { plugins, engine: profile?.getEngine().name ?? null, limits: profile?.getOysterLimits() ?? null,
    annotations, scenario: config.scenario, expectedHandlers: config.expectedHandlers || [] };
}

export default async function serve(options) {
  const server = await cds.server(options);
  const deadline = Date.now() + 15000;
  while (state().annotations.length !== (config.expectedHandlers?.length || 0)) {
    if (Date.now() >= deadline) throw new Error('Oyster handler activation did not complete: ' + JSON.stringify(state()));
    await new Promise(done => setTimeout(done, 20));
  }
  if (config.scenario.hook) await cds.connect.to('BenchmarkExtensionService');
  if (config.diagnostics) cds.db.before('*', req => queries.push({ event: req.event, target: req.target?.name, query: req.query }));
  const callbackDiagnostics = config.diagnostics ? installCallbackDiagnostics() : null;
  cds.app.get('/__benchmark/status', (_, response) => response.json(state()));
  cds.app.get('/__benchmark/queries', (_, response) => response.json(queries));
  if (callbackDiagnostics) {
    cds.app.post('/__benchmark/diagnostics/reset', (_, response) => { queries.length = 0; callbackDiagnostics.reset(); response.json({ ok: true }); });
    cds.app.get('/__benchmark/callbacks', (_, response) => response.json(callbackDiagnostics.summary()));
  }
  process.on('message', async message => {
    try {
      if (message.type === 'metrics-start') { sampler.start(); process.send?.({ token: message.token, value: true }); }
      if (message.type === 'metrics-stop') process.send?.({ token: message.token, value: sampler.stop() });
      if (message.type === 'shutdown') { await cds.shutdown(); server.close(); }
    } catch (error) { process.send?.({ token: message.token, error: { message: error.message, code: error.code } }); }
  });
  if (!server.listening) await new Promise(done => server.once('listening', done));
  process.send?.({ type: 'ready', url: 'http://127.0.0.1:' + server.address().port, state: state() });
  return server;
}
