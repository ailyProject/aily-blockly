const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createElectronDevLaunchOptions,
  isCoderDevMode,
} = require('./run-electron-dev');

const packageScripts = require('../package.json').scripts;

test('exposes a separate electron:coder command without changing electron', () => {
  assert.equal(
    packageScripts.electron,
    'concurrently "npm start" "wait-on tcp:4200 && node ./scripts/run-electron-dev.js --serve"',
  );
  assert.equal(packageScripts['electron:coder'], 'node ./scripts/run-electron-coder-dev.js');
});

test('recognizes the electron:coder runner flag without forwarding it to Electron', () => {
  const launch = createElectronDevLaunchOptions(
    ['--serve', '--coder'],
    { ELECTRON_RUN_AS_NODE: '1' },
  );

  assert.equal(isCoderDevMode(['--coder']), true);
  assert.equal(launch.coderMode, true);
  assert.equal(launch.env.AILY_BUILD_PRODUCT, 'coder');
  assert.equal(launch.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.deepEqual(launch.electronArgs, ['--serve']);
});

test('keeps the existing npm run electron command in Blockly mode', () => {
  const launch = createElectronDevLaunchOptions(['--serve'], {});
  assert.equal(launch.coderMode, false);
  assert.equal(launch.env.AILY_BUILD_PRODUCT, 'blockly');
  assert.deepEqual(launch.electronArgs, ['--serve']);
});
