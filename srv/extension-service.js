import cds from '@sap/cds';
import { settings } from '../lib/settings.mjs';
import { executeWork } from '../lib/workload.mjs';
import { nativeIO } from './benchmark-service.js';

export default class BenchmarkExtensionService extends cds.ApplicationService {
  async init() {
    const s = settings().scenario;
    if (s.hook && s.mode.startsWith('native-')) {
      const io = nativeIO(this, s);
      this.on('evaluate', req => s.mode === 'native-empty' ? req.data.seed : executeWork(req.data, io));
    }
    return super.init();
  }
}
