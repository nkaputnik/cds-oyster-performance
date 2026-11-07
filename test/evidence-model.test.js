const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { resolve } = require('node:path');
const cds = require('@sap/cds');
const { extensibleCheck } = require('@sap/cds-oyster/lib/validations/extensionCheck');

const root = resolve(__dirname, '..');
const models = ['apps/provider/db', 'apps/provider/srv'];
const cli = resolve(root, 'node_modules/@sap/cds-dk/bin/cds.js');

test('CDS CLI compiles dedicated evidence tables to HANA with BLOB part storage', () => {
  const sql = execFileSync(process.execPath, [cli, 'compile', ...models, '--to', 'sql', '--dialect', 'hana'], { cwd: root, encoding: 'utf8' });
  assert.match(sql, /CREATE TABLE benchmark_evidence_Runs/);
  assert.match(sql, /CREATE TABLE benchmark_evidence_Artifacts/);
  assert.match(sql, /CREATE TABLE benchmark_evidence_ArtifactParts[\s\S]*?content BLOB NOT NULL/);
  assert.match(sql, /CONSTRAINT benchmark_evidence_ArtifactParts_artifactOrdinal UNIQUE \(artifact_ID, ordinal\)/);
});

test('evidence entities and actions reject tenant code and do not join benchmark projections', async () => {
  const model = cds.linked(await cds.load(models));
  assert.equal(model.definitions.BenchmarkEvidenceService['@requires'], 'BenchmarkRecorder');
  for (const [name, definition] of Object.entries(model.definitions)) {
    if (name.startsWith('benchmark.evidence.') || name.startsWith('BenchmarkEvidenceService.')) {
      if (definition.kind === 'entity' || definition.kind === 'action') assert.equal(extensibleCheck(name, null, {}, model).length, 1, name);
      if (definition.kind === 'entity' && name.startsWith('BenchmarkEvidenceService.')) assert.equal(definition['@readonly'], true);
    }
    if (name.startsWith('BenchmarkService.') || name.startsWith('BenchmarkExtensionService.'))
      assert.equal(JSON.stringify(definition.query || {}).includes('benchmark.evidence'), false, name);
  }
  assert.equal(model.definitions['BenchmarkEvidenceService.ArtifactParts'], undefined);
  assert.equal(model.definitions['BenchmarkEvidenceService.Artifacts'].elements.parts, undefined);
});

test('CDS CLI generates the recorder role and checked-in XSUAA metadata preserves MTX roles', () => {
  const generated = JSON.parse(execFileSync(process.execPath, [cli, 'compile', ...models, '--to', 'xsuaa'], { cwd: root, encoding: 'utf8' }));
  const stored = require('../xs-security.json');
  for (const scope of generated.scopes) assert.ok(stored.scopes.some(item => item.name === scope.name));
  for (const role of generated['role-templates']) assert.ok(stored['role-templates'].some(item => item.name === role.name));
  assert.ok(stored.scopes.some(item => item.name === '$XSAPPNAME.mtcallback'));
  assert.ok(stored['role-templates'].some(item => item.name === 'ExtensionDeveloper'));
});
