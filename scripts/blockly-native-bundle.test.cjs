const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertIndependentBundle, prepareNativeBundle } = require('./blockly-native-bundle.cjs');

function result(inputs = ['node_modules/blockly/blockly_compressed.js'], output = {}) {
  return { metafile: { inputs: Object.fromEntries(inputs.map(input => [input, {}])),
    outputs: { 'candidate.js': { imports: [], exports: [], ...output } } } };
}
test('rejects host frameworks, external imports and multiple Blockly cores', () => {
  assert.throws(() => assertIndependentBundle(result(['node_modules/@angular/core/fesm2022/core.mjs'])));
  assert.throws(() => assertIndependentBundle(result(undefined, { imports: [{ path: 'host.js' }] })));
  assert.throws(() => assertIndependentBundle(result(['one/blockly_compressed.js', 'two/blockly_compressed.js'])));
  assert.doesNotThrow(() => assertIndependentBundle(result()));
});
test('builds the actual shared native implementations as one independent asset', async () => {
  const bundle = await prepareNativeBundle();
  const inputs = Object.keys(bundle.metafile.inputs);
  for (const suffix of ['field-multilineinput.ts', 'field-u8g2-animation.ts', 'generators/arduino/arduino.ts',
    'generators/micropython/micropython.ts', 'generators/python/python.ts', 'abs-syntax-binding.ts']) {
    assert.ok(inputs.some(file => file.endsWith(suffix)), suffix);
  }
});
