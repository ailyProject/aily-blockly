const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test, after } = require('node:test');
const { buildSync } = require('esbuild');

const outputRoot = path.resolve(__dirname, 'test-results/native-request-footprint');
fs.mkdirSync(outputRoot, { recursive: true });
const output = fs.mkdtempSync(path.join(outputRoot, 'case-'));
const bundle = path.join(output, 'footprint.cjs');
buildSync({ entryPoints: [path.resolve(__dirname, '../src/app/editors/blockly-editor/services/blockly-native-request-footprint.ts')],
  bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
const { nativeRequestFootprint } = require(bundle);
after(() => {
  const relative = path.relative(fs.realpathSync(outputRoot), fs.realpathSync(output));
  assert.ok(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  fs.rmSync(output, { recursive: true });
});

test('SharedArrayBuffer raw store and all shared views are rejected before budgeting', () => {
  const store = new SharedArrayBuffer(1024);
  for (const value of [store, new Uint8Array(store, 7, 1), new DataView(store, 5, 1)]) {
    assert.throws(() => nativeRequestFootprint({ value }), error => error.code === 'ABS_NATIVE_RESOURCE_INVALID'
      && error.diagnostic.reason === 'shared-mutable-resource');
  }
});

test('shared mutable stores from another Realm remain rejected', () => {
  for (const expression of ['new SharedArrayBuffer(32)', 'new Uint8Array(new SharedArrayBuffer(32))',
    'new DataView(new SharedArrayBuffer(32))']) {
    const value = vm.runInNewContext(expression);
    assert.throws(() => nativeRequestFootprint({ value }), error => error.code === 'ABS_NATIVE_RESOURCE_INVALID');
  }
});

test('thin, raw and overlapping views count complete unique backing stores', () => {
  const backing = new ArrayBuffer(4096), second = new ArrayBuffer(4096);
  const value = { thin: new Uint8Array(backing, 3, 1), overlap: new DataView(backing, 3, 2), backing, second };
  const actual = nativeRequestFootprint(value);
  assert.equal(actual.backingBuffers, 2); assert.equal(actual.backingBytes, 8192);
  assert.equal(actual.units, actual.textCharacters + 8192);
  const cloned = structuredClone(value);
  assert.equal(cloned.thin.buffer, cloned.backing); assert.equal(cloned.overlap.buffer, cloned.backing);
  assert.deepEqual(nativeRequestFootprint(cloned), actual);
});

test('cross-Realm raw ArrayBuffer is accounted without trusting an object tag', () => {
  const value = vm.runInNewContext('const backing = new ArrayBuffer(1024); ({ backing, view: new Uint16Array(backing, 2, 1) })');
  assert.equal(nativeRequestFootprint(value).backingBytes, 1024);
  assert.equal(nativeRequestFootprint({ [Symbol.toStringTag]: 'ArrayBuffer', byteLength: 90000000 }).backingBytes, 0);
});

test('binary brands cannot be hidden or trigger accessors through custom tags/properties', () => {
  let hooks = 0;
  const backing = new ArrayBuffer(1024), view = new Uint8Array(backing, 7, 1);
  for (const value of [backing, view]) Object.defineProperty(value, Symbol.toStringTag, { get() { hooks++; throw Error('foreign tag'); } });
  Object.defineProperty(view, 'buffer', { get() { hooks++; throw Error('foreign buffer'); } });
  Object.defineProperty(view, 'byteLength', { get() { hooks++; return NaN; } });
  Object.defineProperty(backing, 'byteLength', { get() { hooks++; return NaN; } });
  const result = nativeRequestFootprint({ backing, view });
  assert.equal(result.backingBytes, 1024); assert.equal(result.backingBuffers, 1);
  assert.equal(Number.isSafeInteger(result.units), true); assert.equal(hooks, 0);
});

test('tagged shared stores and views remain fail closed', () => {
  const backing = new SharedArrayBuffer(32), view = new Uint8Array(backing);
  Object.defineProperty(backing, Symbol.toStringTag, { value: 'ArrayBuffer' });
  Object.defineProperty(view, Symbol.toStringTag, { value: 'Object' });
  for (const value of [backing, view]) assert.throws(() => nativeRequestFootprint({ value }),
    error => error.code === 'ABS_NATIVE_RESOURCE_INVALID');
});

test('a cross-Realm shared view cannot produce NaN when the receiver has no SharedArrayBuffer global', () => {
  const context = { module: { exports: {} }, SharedArrayBuffer: undefined };
  vm.runInNewContext(fs.readFileSync(bundle, 'utf8'), context);
  const receiver = context.module.exports.nativeRequestFootprint;
  const backing = new SharedArrayBuffer(64);
  for (const value of [backing, new Uint8Array(backing, 5, 1), new DataView(backing, 5, 1)]) {
    assert.throws(() => receiver({ value }), error => error.code === 'ABS_NATIVE_RESOURCE_INVALID'
      && error.diagnostic.reason === 'shared-mutable-resource');
  }
});

test('policy-side snapshots cannot hide backing bytes with a caller-owned toJSON function', () => {
  let hooks = 0;
  const view = new Uint8Array(new ArrayBuffer(8192), 1, 1);
  view.toJSON = () => { hooks++; return null; };
  const detached = structuredClone({ view });
  assert.equal(Object.hasOwn(detached.view, 'toJSON'), false);
  assert.equal(nativeRequestFootprint(detached).backingBytes, 8192);
  assert.equal(hooks, 0);
  assert.throws(() => structuredClone({ toJSON() { hooks++; return null; }, view }), { name: 'DataCloneError' });
  assert.equal(hooks, 0);
});
