const assert = require('node:assert/strict');
const test = require('node:test');

const {
  normalizeBuildProduct,
} = require('./build-product');

test('defaults unknown product values to Blockly', () => {
  assert.equal(normalizeBuildProduct(undefined), 'blockly');
  assert.equal(normalizeBuildProduct('other'), 'blockly');
  assert.equal(normalizeBuildProduct('CODER'), 'coder');
});
