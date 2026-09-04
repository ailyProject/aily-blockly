const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createBuilderConfig,
  createBuildPlan,
  resolveProductUpdaterUrl,
} = require('./build-electron');

const config = {
  regions: {
    cn: { updater: 'https://dl.yiyu.pro/blockly' },
    eu: { updater: 'https://dl.aily.pro/blockly' },
  },
};

test('keeps product selection out of coder configuration', () => {
  const coderConfig = require('../electron/config/config.json').coder;
  assert.deepEqual(coderConfig, { enabled: false });
});

test('keeps the existing Blockly build profile by default', () => {
  const plan = createBuildPlan(['--flavor', 'global'], config);
  assert.equal(plan.buildProduct, 'blockly');
  assert.equal(plan.artifactPrefix, 'aily-blockly');
  assert.equal(plan.updateBaseUrl, 'https://dl.aily.pro/blockly');
  assert.ok(plan.builderArgs.includes('-c.extraMetadata.ailyBuildProduct=blockly'));
  assert.ok(!plan.builderArgs.includes('build/electron-builder.coder.js'));
});

test('creates a separately named Aily Coder product build profile', () => {
  const plan = createBuildPlan(['--product', 'coder'], config);
  assert.equal(plan.buildFlavor, 'cn');
  assert.equal(plan.buildProduct, 'coder');
  assert.equal(plan.artifactPrefix, 'aily-coder-CN');
  assert.equal(plan.updateBaseUrl, 'https://dl.yiyu.pro/coder');
  assert.deepEqual(plan.builderArgs, ['build', '--config', 'build/electron-builder.coder.js']);

  const builderConfig = createBuilderConfig(plan, require('../package.json').build);
  assert.equal(builderConfig.appId, 'coder.aily.pro');
  assert.equal(builderConfig.productName, 'aily coder');
  assert.equal(builderConfig.extraMetadata.name, 'aily-coder');
  assert.equal(builderConfig.extraMetadata.productName, 'aily coder');
  assert.equal(builderConfig.extraMetadata.ailyBuildProduct, 'coder');
  assert.equal(builderConfig.directories.output, 'dist/aily-coder/');
  assert.equal(builderConfig.publish[0].url, 'https://dl.yiyu.pro/coder');
  assert.ok(!builderConfig.extraResources.some((resource) => resource.to === 'app-update.yml'));
  assert.equal(builderConfig.nsis.include, 'build/installer-coder.nsh');
  assert.equal(builderConfig.nsis.shortcutName, 'aily coder');
  assert.equal(builderConfig.win.fileAssociations, undefined);
  assert.equal(builderConfig.mac.fileAssociations, undefined);
  assert.equal(builderConfig.linux.fileAssociations, undefined);
});

test('uses the dedicated Coder icons in packaged builds', () => {
  const builderConfig = require('../build/electron-builder.coder');
  const packagedIcon = builderConfig.extraResources.find((resource) => resource.to === 'icon.ico');

  assert.equal(builderConfig.win.icon, 'public/icon-aci.ico');
  assert.equal(builderConfig.mac.icon, 'public/icon-512-coder.ico');
  assert.equal(builderConfig.linux.icon, 'public/icon-aci.ico');
  assert.equal(packagedIcon.from, 'public/icon-aci.ico');
});

test('maps an updater base URL without a Blockly suffix into a Coder child path', () => {
  assert.equal(
    resolveProductUpdaterUrl('https://downloads.example.com/releases/', 'coder'),
    'https://downloads.example.com/releases/coder',
  );
});
