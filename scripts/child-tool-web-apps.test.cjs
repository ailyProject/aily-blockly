const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stripTypeScriptTypes } = require('node:module');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname,
  '../src/app/tools/child-tool-presentation/child-tool-web-apps.ts'), 'utf8');
const subject = import('data:text/javascript;base64,' + Buffer.from(
  stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));
const load = async () => { throw Error('Discovery must not load a component.'); };

test('native discovery ignores Web descriptors', async () => {
  const { hasWebToolApp, projectWebToolApps } = await subject;
  const presentations = { example: { load, app: { name: 'Example' } } };
  assert.deepEqual(projectWebToolApps('native', presentations), []);
  assert.equal(hasWebToolApp('native', presentations, 'example'), false);
});

test('Web discovery fixes tool identity and excludes native installation fields', async () => {
  const { hasWebToolApp, projectWebToolApps } = await subject;
  const presentations = { example: { load, app: { name: 'Example', id: 'foreign', action: 'foreign',
    data: { data: 'foreign' }, subapp: { installed: true }, extension: true, runtime: { headless: true } } } };
  const [app] = projectWebToolApps('web', presentations);
  assert.equal(hasWebToolApp('web', presentations, 'example'), true);
  assert.equal(app.id, 'example'); assert.equal(app.action, 'tool-open');
  assert.deepEqual(app.data, { type: 'tool', data: 'example' });
  for (const field of ['subapp', 'installed', 'extension', 'runtime', 'load']) assert.equal(field in app, false);
});

test('display projection preserves explicit restrictions and copies mutable arrays', async () => {
  const { projectWebToolApps } = await subject;
  const metadata = { name: 'Example', description: 'Description', icon: 'icon', only: 'aily blockly',
    router: ['/main'], core: ['avr'], enabled: false, defaultToolbar: true };
  const [app] = projectWebToolApps('web', { example: { load, app: metadata } });
  assert.equal(app.enabled, false); assert.equal(app.defaultToolbar, true); assert.equal(app.only, metadata.only);
  assert.equal(app.description, metadata.description); assert.equal(app.icon, metadata.icon);
  app.router.push('/other'); app.core.push('other');
  assert.deepEqual(metadata.router, ['/main']); assert.deepEqual(metadata.core, ['avr']);
});

test('unknown, inherited and incomplete descriptors cannot enter discovery', async () => {
  const { hasWebToolApp, projectWebToolApps } = await subject;
  const presentations = Object.assign(Object.create({ inherited: { load, app: { name: 'Inherited' } } }), {
    missingLoader: { app: { name: 'Missing' } }, missingMetadata: { load }, emptyName: { load, app: { name: ' ' } },
  });
  assert.deepEqual(projectWebToolApps('web', presentations), []);
  for (const id of ['inherited', 'constructor', 'unknown', 'missingLoader', 'missingMetadata', 'emptyName']) {
    assert.equal(hasWebToolApp('web', presentations, id), false);
  }
});

test('metadata mutation of a projected item cannot change its fixed next projection', async () => {
  const { projectWebToolApps } = await subject;
  const presentations = Object.freeze({ example: Object.freeze({ load, app: Object.freeze({ name: 'Example' }) }) });
  const [first] = projectWebToolApps('web', presentations);
  first.id = 'foreign'; first.data.data = 'foreign'; first.name = 'Changed';
  const [second] = projectWebToolApps('web', presentations);
  assert.equal(second.id, 'example'); assert.equal(second.name, 'Example');
  assert.deepEqual(second.data, { type: 'tool', data: 'example' });
  assert.equal(second.enabled, true); assert.equal(second.defaultToolbar, false);
});
