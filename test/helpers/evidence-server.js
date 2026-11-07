const cds = require('@sap/cds');
const express = require('express');
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');

async function main() {
  const provider = resolve(__dirname, '../../apps/provider');
  cds.root = provider;
  cds.env = cds.env.for('cds', provider);
  Object.assign(cds.env.requires, {
    db: { kind: 'sqlite', impl: require.resolve('@cap-js/sqlite'), credentials: { url: process.argv[2] } },
    multitenancy: true, extensibility: false, toggles: false,
    auth: { kind: 'mocked', users: {
      recorder: { tenant: 'tenant-a', roles: ['BenchmarkRecorder'] },
      otherRecorder: { tenant: 'tenant-b', roles: ['BenchmarkRecorder'] },
      viewer: { tenant: 'tenant-a', roles: [] },
      noTenant: { roles: ['BenchmarkRecorder'] },
      '*': false,
    } },
  });
  const evidence = resolve(provider, 'srv/evidence-service.cds');
  cds.model = await cds.load(existsSync(evidence) ? evidence : resolve(provider, 'srv'));
  await cds.connect.to('db');
  const app = express();
  app.use(cds.middlewares.before);
  await cds.serve('all').from(cds.model).in(app);
  app.use(cds.middlewares.after);
  const server = app.listen(0, '127.0.0.1', error => {
    if (error) { console.error(error); process.exit(1); }
    process.send({ url: 'http://127.0.0.1:' + server.address().port });
  });
  process.on('message', async message => {
    if (message !== 'stop') return;
    await new Promise(done => server.close(done));
    await cds.db.disconnect();
    process.exit(0);
  });
}

main().catch(error => { console.error(error); process.exit(1); });
