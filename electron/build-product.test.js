const assert = require('node:assert/strict');
const test = require('node:test');
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
