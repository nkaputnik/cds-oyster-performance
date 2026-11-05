import cds from '@sap/cds';
import { executeWork, cpu } from '../lib/workload.mjs';
import { settings, workInput } from '../lib/settings.mjs';

export function nativeIO(srv, scenario) {
  const { SELECT, UPDATE } = cds.ql;
  const runner = scenario.access === 'db' ? cds.db : srv;
  const lookup = scenario.access === 'db' ? 'perf.LookupRows' : srv.entities.LookupRows;
  const effect = scenario.access === 'db' ? 'perf.SideEffectRows' : srv.entities.SideEffectRows;
  return { kind: scenario.mode.endsWith('-read') ? 'read' : scenario.mode.endsWith('-write') ? 'write' : '',
    read: async ID => {
      const row = await runner.run(SELECT.one.from(lookup).columns('value').where({ ID }));
      if (!row) throw new Error('Auxiliary lookup did not find the fixture key');
      return row.value;
    },
    write: (ID, value) => runner.run(UPDATE.entity(effect).set({ value }).where({ ID })),
  };
}

export default class BenchmarkService extends cds.ApplicationService {
  async init() {
    const config = settings();
    const s = config.scenario;
    const native = s.mode.startsWith('native-');
    const wasm = s.mode.startsWith('wasm-');
    const io = nativeIO(this, s);
    const empty = !native || s.mode === 'native-empty';
    let extension;
    const runWork = async input => {
      if (s.hook) {
        extension ??= await cds.connect.to('BenchmarkExtensionService');
        return await extension.evaluate(input) ?? input.seed;
      }
      return empty ? input.seed : executeWork(input, io);
    };

    this.on('probe', () => 1);
    if (!wasm || s.hook) {
      this.on('noop', () => undefined);
      this.on('compute', req => runWork(workInput(req.data, config)));
      this.on('scan', async req => {
        let cursor = req.data.cursor ?? 0;
        let left = req.data.count;
        let checksum = 0;
        const pageSize = req.data.pageSize;
        while (left > 0) {
          const rows = await this.run(cds.ql.SELECT.from(this.entities.LargeRows).columns('ID', 'value')
            .where`ID > ${cursor}`.orderBy('ID').limit(Math.min(pageSize, left)));
          if (!rows.length) req.reject(400, 'Scan requested more rows than exist');
          for (const row of rows) checksum = (checksum + cpu(row.value, s.iterations)) & 2147483647;
          left -= rows.length;
          cursor = rows[rows.length - 1].ID;
        }
        return checksum;
      });
    }

    if ((native || s.hook) && (['create', 'update'].includes(s.operation) || s.mixed)) {
      this.before(['CREATE', 'UPDATE'], 'WriteRows', async req => {
        if (s.mode === 'native-empty' && !s.hook) return;
        req.data.value = await runWork(workInput(req.data, config));
      });
    }
    if ((native || s.hook || s.hookControl) && (s.operation === 'read' || s.mixed)) {
      this.after('READ', ['SmallRows', 'LargeRows'], async (rows, req) => {
        if (s.mode === 'native-empty' && !s.hook) return;
        if (!Array.isArray(rows)) rows = rows ? [rows] : [];
        if (s.hookControl) {
          if (s.hook) await runWork(workInput({ value: rows[0]?.value ?? 0 }, config));
          return;
        }
        if (s.hook) {
          const value = await runWork(workInput({ value: rows[0]?.value ?? 0 }, config));
          for (const row of rows) row.checksum = (cpu(row.value, s.iterations) + value) & 2147483647;
          return;
        }
        let extra = 0;
        if (s.enrichment !== 'per-row' && io.kind)
          extra = await executeWork({ ...workInput({}, config), seed: 0, iterations: 0 }, io);
        for (const row of rows) {
          row.checksum = s.enrichment === 'per-row'
            ? await executeWork(workInput(row, config), io)
            : (cpu(row.value, s.iterations) + extra) & 2147483647;
        }
      });
    }

    this.on('rollbackProbe', async req => {
      const { INSERT, UPDATE } = cds.ql;
      await this.run(INSERT.into(this.entities.WriteRows).entries({ ID: req.data.ID, value: req.data.value }));
      await this.run(UPDATE.entity(this.entities.SideEffectRows).set({ value: req.data.value }).where({ ID: req.data.effectID }));
      req.reject(409, 'Deliberate rollback probe');
    });
    return super.init();
  }
}
