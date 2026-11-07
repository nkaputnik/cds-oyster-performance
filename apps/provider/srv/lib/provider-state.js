const cds = require('@sap/cds');
const { createHash, randomUUID } = require('node:crypto');
const { hostname } = require('node:os');
const { readFile } = require('node:fs/promises');
const { getHeapStatistics } = require('node:v8');

const instance = Object.freeze({ ID: randomUUID(), pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(),
  cfInstanceID: process.env.CF_INSTANCE_GUID || null, cfInstanceIndex: process.env.CF_INSTANCE_INDEX || null });
function version(name) { try { return require(name + '/package.json').version; } catch { return null; } }
const versions = Object.freeze({ node: process.version, cds: version('@sap/cds'), oyster: version('@sap/cds-oyster'),
  mtxs: version('@sap/cds-mtxs'), hana: version('@cap-js/hana') });
function annotations(model) {
  const result = [];
  const add = (name, definition) => {
    for (const annotation of definition?.['@extension.code'] || []) if (!annotation['...'])
      result.push({ name, phase: annotation.phase, event: annotation.event, extId: annotation.extId || null });
  };
  for (const [name, definition] of Object.entries(model?.definitions || {})) {
    add(name, definition);
    for (const [action, value] of Object.entries(definition.actions || {})) add(name + '.' + action, value);
  }
  return [...new Map(result.map(value => [JSON.stringify(value), value])).values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
async function memoryLimit() {
  const configured = process.env.MEMORY_LIMIT?.match(/^(\d+(?:\.\d+)?)([kmg])?b?$/i);
  if (configured) return { bytes: Number(configured[1]) * 1024 ** ({ k: 1, m: 2, g: 3 }[configured[2]?.toLowerCase()] ?? 2), source: 'MEMORY_LIMIT' };
  for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const bytes = Number((await readFile(path, 'utf8')).trim());
      if (Number.isSafeInteger(bytes) && bytes > 0) return { bytes, source: path };
    } catch { /* Platform has no cgroup limit at this path. */ }
  }
  return { bytes: null, source: 'unavailable', heapLimitBytes: getHeapStatistics().heap_size_limit };
}
async function extensionState(db, model) {
  const actual = annotations(model), installed = versions.oyster;
  const rows = await db.run(cds.ql.SELECT.from('cds.xt.Extensions').columns('ID', 'tag', 'appid', 'activated', 'timestamp', 'csn',
    'cdsOysterVersion', 'isBlockedCode', 'blockedCodeReason').orderBy('ID'));
  const extensions = rows.map(({ csn, ...row }) => {
    let parsed, parseError;
    try { parsed = JSON.parse(csn); } catch { parseError = true; }
    const expected = [];
    for (const entry of parsed?.extensions || []) {
      for (const code of entry['@extension.code'] || []) if (!code['...']) expected.push({ name: entry.annotate, phase: code.phase, event: code.event });
      for (const [action, value] of Object.entries(entry.actions || {})) for (const code of value['@extension.code'] || []) if (!code['...'])
        expected.push({ name: entry.annotate + '.' + action, phase: code.phase, event: code.event });
    }
    return { ...row, version: parsed?.meta?.version || row.timestamp, csnSha256: createHash('sha256').update(csn || '').digest('hex'),
      codeHandlers: expected.length, parseError: Boolean(parseError), active: row.activated === 'database', versionMatches: row.cdsOysterVersion === installed,
      annotationsMatch: expected.length > 0 && expected.every(code => actual.some(annotation => annotation.extId === row.ID &&
        annotation.name === code.name && annotation.phase === code.phase && annotation.event === code.event)) };
  });
  const code = extensions.filter(extension => extension.codeHandlers || extension.cdsOysterVersion || extension.isBlockedCode);
  const extensionHealthy = code.length > 0 && code.every(extension => extension.active && !extension.parseError &&
    !extension.isBlockedCode && extension.versionMatches && extension.annotationsMatch) &&
    actual.every(annotation => code.some(extension => extension.ID === annotation.extId && !extension.isBlockedCode));
  return { annotations: actual, extensions, extensionHealthy,
    extensionFingerprint: createHash('sha256').update(JSON.stringify(extensions)).digest('hex') };
}
async function providerState(req) {
  const plugins = Object.keys(cds.env.plugins || {});
  const profile = plugins.includes('@sap/cds-oyster') ? require('@sap/cds-oyster/lib/profile') : null;
  const model = cds.context?.model || cds.db.tx(req).model;
  return { tenant: req.tenant, instance, versions, memoryLimit: await memoryLimit(), plugins,
    logging: { levels: cds.env.log?.levels || {}, default: cds.env.log?.level || null },
    engine: profile?.getEngine().name || null, limits: profile?.getOysterLimits() || null,
    ...await extensionState(cds.db.tx(req), model) };
}
module.exports = { instance, versions, extensionState, providerState };
