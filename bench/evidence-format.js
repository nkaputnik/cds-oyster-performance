// Keep measured values and correctness decisions, rather than copies of their inputs.
const scalar = value => value === null || ['string', 'number', 'boolean'].includes(typeof value);
const scalars = object => Object.fromEntries(Object.entries(object || {}).filter(([, value]) => scalar(value)));
function validation(value) {
  if (Array.isArray(value)) return value.map(validation);
  if (!value || typeof value !== 'object') return value;
  const compact = Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'response').map(([key, item]) =>
    [key, key === 'activation' ? validation(Object.fromEntries(Object.entries(item).filter(([name]) => !['limits', 'plugins'].includes(name)))) : validation(item)]));
  if (value.status === 400 && value.response?.body?.error?.message) compact.rejectionMessage = value.response.body.error.message;
  return compact;
}
function state(value) {
  if (!value) return value;
  return { tenant: value.tenant, engine: value.engine, instance: { ID: value.instance?.ID },
    extensionHealthy: value.extensionHealthy, extensionFingerprint: value.extensionFingerprint };
}
function compactResult(record) {
  const { pairID, runtime, serverExit, ...result } = record;
  result.validation = validation(record.validation);
  result.activeState = state(record.activeState);
  result.cloudPostflightState = state(record.cloudPostflightState);
  if (result.validation?.passed && !result.error) delete result.rawFile;
  return result;
}
function compactManifest(manifest) {
  const { runOrder, artifacts, ...result } = manifest;
  result.environment = { ...manifest.environment };
  delete result.environment.dependencyTreeFile;
  if (result.environment.runner) {
    result.environment.runner = { ...result.environment.runner };
    delete result.environment.runner.dependencyTreeFile;
  }
  if (manifest.fixture) result.fixture = { ...scalars(manifest.fixture), hashes: manifest.fixture.hashes,
    tables: Object.fromEntries(Object.entries(manifest.fixture.tables || {}).map(([name, table]) => [name, scalars(table)])),
    sources: Object.fromEntries(Object.entries(manifest.fixture.sources || {}).map(([name, source]) => [name, scalars(source)])) };
  result.reporting = { ...manifest.reporting, compact: true, sourceRoot: '../../apps/extension/srv/' };
  return result;
}
module.exports = { compactResult, compactManifest };
