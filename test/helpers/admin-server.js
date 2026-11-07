const cds = require('@sap/cds');
const express = require('express');
const { resolve } = require('node:path');

async function main() {
  const provider = resolve(__dirname, '../../apps/provider');
  cds.root = provider;
  cds.env = cds.env.for('cds', provider);
  Object.assign(cds.env.requires, {
    db: { kind: 'sqlite', impl: require.resolve('@cap-js/sqlite'), credentials: { url: process.argv[2] } },
    multitenancy: true, extensibility: false, toggles: false,
    auth: { kind: 'mocked', users: {
      admin: { tenant: 'tenant-a', roles: ['BenchmarkAdministrator', 'BenchmarkRecorder'] },
      second: { tenant: 'tenant-a', roles: ['BenchmarkAdministrator'] },
      other: { tenant: 'tenant-b', roles: ['BenchmarkAdministrator', 'BenchmarkRecorder'] },
      viewer: { tenant: 'tenant-a', roles: [] },
      noTenant: { roles: ['BenchmarkAdministrator'] }, '*': false,
    } },
  });
  cds.env.benchmark = { dataRoot: process.argv[3] };
  cds.env.plugins = { '@sap/cds-oyster': {} };
  const model = await cds.load([resolve(provider, 'srv'), require.resolve('@sap/cds-mtxs/db/extensions.cds')]);
  require('@sap/cds-oyster/lib/services/extService').enhanceModel(model);
  cds.model = cds.compile.for.nodejs(model);
  await cds.connect.to('db');
  const app = express();
  app.use(cds.middlewares.before);
  // Mock ModelProvider's tenant overlay in this HTTP test only. Production uses CAP middleware.
  app.use(async (req, res, next) => {
    try {
      if (cds.context.tenant) {
        const rows = await cds.db.run(cds.ql.SELECT.from('cds.xt.Extensions').columns('csn', 'isBlockedCode'));
        const tenantModel = JSON.parse(JSON.stringify(model));
        for (const row of rows) if (!row.isBlockedCode) for (const extension of JSON.parse(row.csn).extensions || [])
          if (tenantModel.definitions[extension.annotate]) tenantModel.definitions[extension.annotate]['@extension.code'] = extension['@extension.code'];
        cds.context.model = cds.compile.for.nodejs(tenantModel);
      }
      next();
    } catch (error) { next(error); }
  });
  await cds.serve('all').from(cds.model).in(app);
  cds.services.BenchmarkService.before('probe', async req => {
    if (req.headers['x-test-delay'] === 'hold') {
      await new Promise(done => {
        const release = message => {
          if (message !== 'release-held-probe') return;
          process.removeListener('message', release); done();
        };
        process.on('message', release); process.send({ type: 'held-probe-started' });
      });
    } else if (req.headers['x-test-delay']) await new Promise(done => setTimeout(done, 300));
  });
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
