const cds = require('@sap/cds');

cds.on('loaded', model => {
  for (const [service, implementation] of [
    ['BenchmarkService', '../provider/srv/benchmark-service.js'],
    ['BenchmarkExtensionService', '../provider/srv/extension-service.js'],
  ]) {
    if (model.definitions?.[service]) model.definitions[service]['@impl'] = require.resolve(implementation);
  }
});

module.exports = require('../../bench/server.js');
