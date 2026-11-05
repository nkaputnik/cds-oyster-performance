import cds from '@sap/cds';
import { createRequire } from 'node:module';
import { ResourceSampler } from '../../bench/resources.mjs';
import { installCallbackDiagnostics } from './lib/diagnostics.mjs';

const require = createRequire(import.meta.url);
const sampler = new ResourceSampler();
const diagnostics = process.env.BENCHMARK_DIAGNOSTICS === '1';
const queries = [];
function state() {
  const plugins = Object.keys(cds.env.plugins || {}), annotations = [];
  for (const [name, definition] of Object.entries(cds.model?.definitions || {}))
    for (const handler of definition['@extension.code'] || []) annotations.push({ name, phase: handler.phase, event: handler.event });
  const profile = plugins.includes('@sap/cds-oyster') ? require('@sap/cds-oyster/lib/profile') : null;
  return { plugins, engine: profile?.getEngine().name ?? null, limits: profile?.getOysterLimits() ?? null, annotations };
}
export default async function serve(options) {
  const server = await cds.server(options);
  // Oyster compiles all checked-in handlers during startup.
  if (state().engine) {
    const deadline = Date.now() + 15000;
    while (!state().annotations.length) {
      if (Date.now() >= deadline) throw new Error('Static Oyster handlers did not activate');
      await new Promise(done => setTimeout(done, 20));
    }
  }
  if (diagnostics) cds.db.before('*', req => queries.push({ event: req.event, target: req.target?.name, query: req.query }));
  const callbacks = diagnostics ? installCallbackDiagnostics() : null;
  cds.app.get('/__benchmark/status', (_, res) => res.json(state()));
  if (diagnostics) {
    cds.app.get('/__benchmark/queries', (_, res) => res.json(queries));
    cds.app.post('/__benchmark/diagnostics/reset', (_, res) => { queries.length = 0; callbacks.reset(); res.json({ ok: true }); });
    cds.app.get('/__benchmark/callbacks', (_, res) => res.json(callbacks.summary()));
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
