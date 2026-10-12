const assert = require('node:assert/strict');
const test = require('node:test');
const { createBuildPlan, createBuilderConfig } = require('../scripts/build-electron');
const {
  createDevelopmentProtocolArgs,
  getProductAuthConfig,
  isProductProtocolUrl,
  resolveBuildProduct,
} = require('./build-product');

for (const product of ['coder', 'blockly']) {
  test(`${product} OAuth cold start retains product identity without launcher environment`, () => {
    const config = getProductAuthConfig(product);
    const appEntry = 'D:\\Aily Workspace\\electron\\main.js';
    const registered = createDevelopmentProtocolArgs({ appEntry, product, serve: true });
    const callback = `${config.redirectUri}?code=test-code&state=test-state`;
    const restartedProduct = resolveBuildProduct({ argv: ['electron.exe', ...registered, callback] });

    assert.equal(restartedProduct, product);
    assert.deepEqual(getProductAuthConfig(restartedProduct), config);
    assert.equal(isProductProtocolUrl(restartedProduct, callback), true);
    const otherProduct = product === 'coder' ? 'blockly' : 'coder';
    assert.equal(isProductProtocolUrl(restartedProduct, getProductAuthConfig(otherProduct).redirectUri), false);
    assert.equal(registered[0], appEntry);
    assert.equal(registered.includes('--serve'), true);
  });
}

test('packaged product and explicit development environment keep existing precedence', () => {
  const argv = ['electron.exe', 'main.js', '--aily-build-product=coder'];
  assert.equal(resolveBuildProduct(), 'blockly');
  assert.equal(resolveBuildProduct({ argv }), 'coder');
  assert.equal(resolveBuildProduct({ argv, packagedProduct: 'blockly' }), 'blockly');
  assert.equal(resolveBuildProduct({ argv, packagedProduct: 'coder', environment: { AILY_BUILD_PRODUCT: 'blockly' } }), 'blockly');
  assert.equal(resolveBuildProduct({ argv: ['main.js', '--aily-build-product=unknown'] }), 'blockly');
});

test('non-serve development callbacks keep the built renderer mode', () => {
  const args = createDevelopmentProtocolArgs({ appEntry: '/workspace/electron/main.js', product: 'coder' });
  assert.equal(args.includes('--serve'), false);
  assert.equal(resolveBuildProduct({ argv: ['electron', ...args] }), 'coder');
});

test('Coder stable and beta packages use the same product channel at their configured regional updater locations', () => {
  const appConfig = require('./config/config.json');
  for (const flavor of ['cn', 'global']) {
    const plan = createBuildPlan(['--product', 'coder', '--flavor', flavor], appConfig);
    const url = flavor === 'cn' ? 'https://dl.yiyu.pro/blockly' : 'https://dl.aily.pro/blockly';
    assert.equal(plan.updateBaseUrl, url);
    for (const version of ['0.1.7', '0.1.7-beta.1']) {
      const config = createBuilderConfig(plan, { extraMetadata: { version } });
      assert.deepEqual(config.publish, [{ provider: 'generic', url, channel: 'latest-coder' }]);
      assert.equal(config.extraMetadata.version, version);
    }
    const blockly = createBuildPlan(['--flavor', flavor], appConfig);
    assert.deepEqual(createBuilderConfig(blockly, {}).publish, [{ provider: 'generic', url }]);
  }
  const customConfig = { regions: { cn: { updater: 'http://localhost:4874/downloads/' } } };
  assert.equal(createBuildPlan(['--product', 'coder'], customConfig).updateBaseUrl, 'http://localhost:4874/downloads');
});

test('Coder macOS packages include the ARM64 app in DMG and updater ZIP targets', () => {
  const config = require('../build/electron-builder.coder');
  assert.deepEqual(config.mac.target, [
    { target: 'dmg', arch: ['arm64'] },
    { target: 'zip', arch: ['arm64'] },
  ]);
});
