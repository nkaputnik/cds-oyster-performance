const cds = require('@sap/cds');
const { resolve } = require('node:path');
const fixture = require('./lib/fixture-data.js');
const reference = require('./lib/fixture-reference.js');
const { providerState } = require('./lib/provider-state.js');
const control = require('./lib/cloud-control.js');

module.exports = class BenchmarkAdminService extends cds.ApplicationService {
  async init() {
    this.before('*', req => {
      if (!req.user?.is('authenticated-user') || !req.tenant) req.reject(403, 'Authenticated tenant required');
    });
    this.on('inspectFixture', async req => JSON.stringify(await fixture.inspectFixture(cds.db.tx(req), cds.env.benchmark?.dataRoot || resolve(cds.root, 'db/data'))));
    this.on('readReference', async req => JSON.stringify(await reference.readReference(req)));
    this.on('scanReference', async req => JSON.stringify(await reference.scanReference(req)));
    this.on('writeStateHash', async req => JSON.stringify(await fixture.writeStateHash(cds.db.tx(req))));
    this.on('state', async req => JSON.stringify({ ...await providerState(req), ...await control.controlState(req) }));
    for (const action of ['acquireLease', 'renewLease', 'releaseLease', 'metricsStart', 'metricsStop', 'reset', 'resetStatus'])
      this.on(action, async req => JSON.stringify(await control[action](req)));
    return super.init();
  }
};
