const assert = require('node:assert/strict');
const test = require('node:test');
const { refreshApplicationMenu } = require('./application-menu');
const { resolveBuildProduct } = require('./build-product');

function createMenuHarness(applicationName) {
  const about = { role: 'about', label: 'About Electron', enabled: true, visible: true };
  const services = { role: 'services', submenu: { items: [] } };
  const separator = { type: 'separator' };
  const hide = { role: 'hide', label: 'Hide aily blockly', accelerator: 'Command+H', enabled: true, visible: true };
  const hideOthers = { role: 'hideothers', label: 'Hide Others', enabled: true, visible: true };
  const quit = { role: 'quit', label: 'Quit aily blockly', accelerator: 'Command+Q', enabled: false, visible: true };
  const custom = { id: 'custom', label: 'Custom action', click: () => {}, enabled: false };
  const edit = { role: 'editmenu', submenu: { items: [{ role: 'copy' }] } };
  const view = { role: 'viewmenu', submenu: { items: [{ role: 'toggledevtools' }] } };
  const window = { role: 'windowmenu' };
  const help = { role: 'help', submenu: { items: [custom] } };
  const original = { items: [
    { role: 'appmenu', label: 'Electron', submenu: { items: [about, separator, services, hide, hideOthers, quit, custom] } },
    edit, view, window, help,
  ] };
  let installed;
  const Menu = {
    getApplicationMenu: () => original,
    buildFromTemplate: template => ({ items: template }),
    setApplicationMenu: menu => { installed = menu; },
  };
  return { app: { getName: () => applicationName }, Menu, original, get installed() { return installed; } };
}

for (const [label, input] of [
  ['Coder development startup', { environment: { AILY_BUILD_PRODUCT: 'coder' } }],
  ['Coder packaged build', { packagedProduct: 'coder' }],
  ['Coder protocol startup', { argv: ['--aily-build-product=coder'] }],
  ['Blockly default startup', {}],
]) {
  test(`${label} refreshes product labels while preserving native actions`, () => {
    const product = resolveBuildProduct(input);
    const name = product === 'coder' ? 'Aily Coder' : 'aily blockly';
    const harness = createMenuHarness(name);
    assert.equal(refreshApplicationMenu({ ...harness, platform: 'darwin' }), true);
    const installed = harness.installed.items;
    assert.equal(installed[0].label, name);
    assert.equal(installed[0].role, 'appMenu');
    for (const index of [0, 3, 5]) {
      const before = harness.original.items[0].submenu.items[index];
      const after = installed[0].submenu[index];
      assert.equal(Object.hasOwn(after, 'label'), false, 'Electron must regenerate its localized product role label');
      assert.equal(after.role, before.role);
      assert.equal(after.enabled, before.enabled);
      assert.equal(after.visible, before.visible);
      assert.equal(after.accelerator, before.accelerator);
    }
    for (const index of [1, 2, 4, 6]) {
      assert.equal(installed[0].submenu[index], harness.original.items[0].submenu.items[index]);
    }
    for (let index = 1; index < installed.length; index++) {
      assert.equal(installed[index], harness.original.items[index]);
    }
    assert.equal(harness.original.items[0].label, 'Electron');
  });
}

test('Windows and Linux keep their current menu unchanged', () => {
  for (const platform of ['win32', 'linux']) {
    const harness = createMenuHarness('aily blockly');
    assert.equal(refreshApplicationMenu({ ...harness, platform }), false);
    assert.equal(harness.installed, undefined);
  }
});

test('does not invent a menu when the application explicitly has no native menu', () => {
  const harness = createMenuHarness('Aily Coder');
  harness.Menu.getApplicationMenu = () => null;
  assert.equal(refreshApplicationMenu({ ...harness, platform: 'darwin' }), false);
  assert.equal(harness.installed, undefined);
});
