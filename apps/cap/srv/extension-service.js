const cds = require('@sap/cds');
const { cpu, executeWork } = require('../lib/workload.js');
const { nativeIO } = require('./benchmark-service.js');
const { validateAmount } = require('../lib/validation.js');

class BenchmarkExtensionService extends cds.ApplicationService {
  async init() {
    this.on('nativeValidation', req => validateAmount(this, req));
    this.on('nativeValidationRead', req => validateAmount(this, req, true));
    this.on('nativeEmpty', req => req.data.seed);
    this.on('nativeCalculation', req => cpu(req.data.seed, req.data.iterations));
    this.on('nativeCqlRead', req => executeWork(req.data, nativeIO(this, 'read')));
    this.on('nativeCqlWrite', req => executeWork(req.data, nativeIO(this, 'write')));
    return super.init();
  }
}

module.exports = BenchmarkExtensionService;
