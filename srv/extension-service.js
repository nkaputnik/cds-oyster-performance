import cds from '@sap/cds';
import { cpu, executeWork } from '../lib/workload.mjs';
import { nativeIO } from './benchmark-service.js';

export default class BenchmarkExtensionService extends cds.ApplicationService {
  async init() {
    this.on('nativeEmpty', req => req.data.seed);
    this.on('nativeCalculation', req => cpu(req.data.seed, req.data.iterations));
    this.on('nativeCqlRead', req => executeWork(req.data, nativeIO(this, 'read')));
    this.on('nativeCqlWrite', req => executeWork(req.data, nativeIO(this, 'write')));
    return super.init();
  }
}
