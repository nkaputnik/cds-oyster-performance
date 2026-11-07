const cds = require('@sap/cds');
const { cpu, executeWork } = require('./lib/workload.js');
const { validateAmount } = require('./lib/validation.js');
const { enterBenchmarkRequest } = require('./lib/cloud-control.js');

function workInput(data = {}) {
  return { seed: data.seed ?? data.value ?? 7, iterations: data.iterations ?? 100, calls: data.calls ?? 1,
    lookupID: data.lookupID, effectID: data.effectID };
}

function nativeIO(srv, kind, access = 'service') {
  const { SELECT, UPDATE } = cds.ql;
  const runner = access === 'db' ? cds.db : srv;
  const lookup = access === 'db' ? 'perf.LookupRows' : srv.entities.LookupRows;
  const effect = access === 'db' ? 'perf.SideEffectRows' : srv.entities.SideEffectRows;
  return { kind,
    async read(ID) {
      const query = SELECT.one.from(lookup).columns('value');
      if (ID === undefined) query.orderBy('ID'); else query.where({ ID });
      const row = await runner.run(query);
      if (!row) throw new Error('Lookup row missing');
      return row.value;
    },
    async write(ID, value) {
      if (ID === undefined) ID = (await runner.run(SELECT.one.from(effect).columns('ID').orderBy('ID'))).ID;
      await runner.run(UPDATE.entity(effect).set({ value }).where({ ID }));
    },
  };
}

class BenchmarkService extends cds.ApplicationService {
  async init() {
    if (cds.requires.multitenancy) this.before('*', enterBenchmarkRequest);
    const readIO = nativeIO(this, 'read'), writeIO = nativeIO(this, 'write');
    for (const [kind, readLimit] of [['Validation', false], ['ValidationRead', true]]) {
      this.before(['CREATE', 'UPDATE'], 'Native' + kind + 'WriteRows', req => validateAmount(this, req, readLimit));
      this.on('native' + kind, req => validateAmount(this, req, readLimit));
    }
    this.on('noop', () => undefined);
    this.on('nativeNoop', () => undefined);
    this.on('probe', () => 1);
    this.before(['CREATE', 'UPDATE'], 'NativeEmptyWriteRows', () => {});
    this.before(['CREATE', 'UPDATE'], 'NativeCalculationWriteRows', req => { req.data.value = cpu(req.data.value ?? 7, 100); });
    this.before(['CREATE', 'UPDATE'], 'NativeCqlReadWriteRows', async req => { req.data.value = await executeWork({ ...workInput(req.data), iterations: 0 }, readIO); });
    this.before(['CREATE', 'UPDATE'], 'NativeCqlWriteWriteRows', async req => { req.data.value = await executeWork({ ...workInput(req.data), iterations: 0 }, writeIO); });
    this.after('READ', ['NativeEmptySmallRows', 'NativeEmptyLargeRows'], () => {});
    this.after('READ', ['NativeCalculationSmallRows', 'NativeCalculationLargeRows'], rows => {
      for (const row of Array.isArray(rows) ? rows : [rows]) if (row) row.checksum = cpu(row.value, 100);
    });
    for (const [prefix, io] of [['NativeCqlRead', readIO], ['NativeCqlWrite', writeIO]]) {
      this.after('READ', [prefix + 'SmallRows', prefix + 'LargeRows'], async rows => {
        const extra = await executeWork({ seed: 0, iterations: 0, calls: 1 }, io);
        for (const row of Array.isArray(rows) ? rows : [rows]) if (row) row.checksum = (row.value + extra) & 2147483647;
      });
    }
    this.on('nativeCalculation', req => cpu(req.data.seed, req.data.iterations));
    this.on('nativeCqlRead', req => executeWork(req.data, readIO));
    this.on('nativeCqlWrite', req => executeWork(req.data, writeIO));
    this.on('nativeDirectRead', req => executeWork(req.data, nativeIO(this, 'read', 'db')));
    this.on('nativeDirectWrite', req => executeWork(req.data, nativeIO(this, 'write', 'db')));
    this.on('nativeLookupIndividual', async req => {
      let value = cpu(req.data.seed, req.data.iterations);
      for (const ID of req.data.lookupIDs) {
        const row = await this.run(cds.ql.SELECT.one.from(this.entities.LookupRows).columns('ID', 'value').where({ ID }));
        if (!row) req.reject(400, 'Lookup row missing');
        value = (value + row.value) & 2147483647;
      }
      return value;
    });
    this.on('nativeLookupBatch', async req => {
      const rows = await this.run(cds.ql.SELECT.from(this.entities.LookupRows).columns('ID', 'value')
        .where`ID in ${req.data.lookupIDs}`.orderBy('ID'));
      if (rows.length !== req.data.lookupIDs.length) req.reject(400, 'Lookup row missing');
      let value = cpu(req.data.seed, req.data.iterations);
      for (const row of rows) value = (value + row.value) & 2147483647;
      return value;
    });
    for (const prefix of ['native', 'oyster']) for (const kind of ['Empty', 'Calculation', 'CqlRead', 'CqlWrite', 'Validation', 'ValidationRead']) {
      this.on(prefix + kind + 'Extension', async req => {
        const extension = await cds.connect.to('BenchmarkExtensionService');
        return extension[prefix + kind](req.data);
      });
    }
    this.on('extensionBypass', req => req.data.seed);
    this.on('extensionUnimplemented', async req => {
      const extension = await cds.connect.to('BenchmarkExtensionService');
      return await extension.unimplemented(req.data) ?? req.data.seed;
    });
    this.on('nativeScan', async req => {
      let cursor = req.data.cursor, left = req.data.count, checksum = 0;
      while (left > 0) {
        const rows = await this.run(cds.ql.SELECT.from(this.entities.NoHandlerLargeRows).columns('ID', 'value')
          .where`ID > ${cursor}`.orderBy('ID').limit(Math.min(req.data.pageSize, left)));
        if (!rows.length) req.reject(400, 'Scan requested more rows than exist');
        for (const row of rows) checksum = (checksum + cpu(row.value, req.data.iterations ?? 100)) & 2147483647;
        left -= rows.length; cursor = rows.at(-1).ID;
      }
      return checksum;
    });
    this.on('rollbackProbe', async req => {
      await this.run(cds.ql.INSERT.into(this.entities[req.data.entity]).entries({ ID: req.data.ID, value: 7,
        quantity: 2, unitPrice: 10, effectID: req.data.effectID, lookupID: (await this.run(cds.ql.SELECT.one.from(this.entities.LookupRows).columns('ID').orderBy('ID'))).ID }));
      await this.run(cds.ql.UPDATE.entity(this.entities.SideEffectRows).set({ value: req.data.value }).where({ ID: req.data.effectID }));
      req.reject(409, 'Deliberate rollback probe');
    });
    return super.init();
  }
}

module.exports = BenchmarkService;
module.exports.workInput = workInput;
module.exports.nativeIO = nativeIO;
