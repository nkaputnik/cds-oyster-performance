const test = require('node:test');
const assert = require('node:assert/strict');
const cds = require('@sap/cds');
const { extensibleCheck } = require('@sap/cds-oyster/lib/validations/extensionCheck');

test('native references and no-handler controls reject tenant code while Oyster targets accept it', async () => {
  const model = cds.linked(await cds.load('apps/provider/srv'));
  const allowed = [], closed = [];
  for (const [name, definition] of Object.entries(model.definitions)) {
    if (!name.startsWith('Benchmark')) continue;
    if (definition.kind === 'entity' || definition.kind === 'action') {
      (name.split('.').at(-1).startsWith('Oyster') || name.split('.').at(-1).startsWith('oyster') && !name.endsWith('Extension') ? allowed : closed).push(name);
    }
  }
  assert.ok(allowed.length > 20);
  assert.ok(closed.length > 20);
  for (const name of allowed) assert.deepEqual(extensibleCheck(name, null, {}, model), [], name);
  for (const name of closed) assert.equal(extensibleCheck(name, null, {}, model).length, 1, name);
});
