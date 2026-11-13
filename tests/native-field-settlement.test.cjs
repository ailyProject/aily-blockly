'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const { JSDOM } = require('jsdom');
const { window } = new JSDOM('<!doctype html><html><body></body></html>');

Object.assign(globalThis, { window, document: window.document, Element: window.Element, HTMLElement: window.HTMLElement });

const Blockly = require('blockly');
const esbuild = Module.createRequire(require.resolve('@angular/build/package.json'))('esbuild');

// Real Blockly fields and serializers; no renderer or browser is needed.
const root = path.resolve(__dirname, '..');
const bundle = esbuild.buildSync({
  stdin: {
    contents: [
      "export { NativeFieldDependencies, registerNativeFieldInitializer } from './src/app/editors/blockly-editor/services/blockly-native-field-dependencies';",
      "export { withNativeStateLoading } from './src/app/editors/blockly-editor/services/blockly-native-state-loading';",
      "export { NativeUiTasks, nativeUiSemanticSnapshot } from './src/app/editors/blockly-editor/services/blockly-native-ui-tasks';",
    ].join('\n'),
    resolveDir: root,
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  packages: 'external',
  tsconfig: path.join(root, 'tsconfig.json'),
  write: false,
}).outputFiles[0].text;
const compiled = new Module(path.join(__dirname, 'field-settlement-runtime.cjs'), module);
compiled.paths = module.paths;
compiled._compile(bundle, path.join(__dirname, 'field-settlement-runtime.cjs'));
const { NativeFieldDependencies, registerNativeFieldInitializer, withNativeStateLoading, NativeUiTasks, nativeUiSemanticSnapshot } = compiled.exports;

function fixture(t, count, mutate = () => {}) {
  const workspace = new Blockly.Workspace();
  const dependencies = new NativeFieldDependencies(Blockly, workspace);
  const type = 'settlement_probe';
  let ready = false;

  Blockly.Blocks[type] = {
    init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown(() => ready
        ? [['Default', 'default'], ['Requested', 'requested']]
        : [['Default', 'default']]), 'CHOICE');
    },
  };

  const blocks = Array.from({ length: count }, () => workspace.newBlock(type));

  for (const block of blocks) dependencies.defer(block, 'CHOICE', () => {
    ready = true;
    block.getField('CHOICE').getOptions(false);
    block.setFieldValue('requested', 'CHOICE');
    mutate(block, workspace);
  });

  const save = Blockly.serialization.workspaces.save;
  let snapshots = 0;

  Blockly.serialization.workspaces.save = (...args) => {
    snapshots++;
    return save(...args);
  };

  t.after(() => {
    Blockly.serialization.workspaces.save = save;
    dependencies.dispose();
    workspace.dispose();
    delete Blockly.Blocks[type];
  });

  return { dependencies, blocks, snapshots: () => snapshots };
}

test('deferred fields settle as one checked batch with a fixed allowed field set', t => {
  const f = fixture(t, 32);

  f.dependencies.settle();

  assert.ok(f.blocks.every(block => block.getFieldValue('CHOICE') === 'requested'));
  assert.equal(f.dependencies.blocks.size, 0);
  // Two UI-phase reads plus two field-retry reads, independent of field count.
  assert.equal(f.snapshots(), 4);
});

test('the batch still rejects a final unrelated model or topology mutation', async t => {
  for (const mutation of ['variable', 'block']) await t.test(mutation, t => {
    let changed = false;
    const f = fixture(t, 3, (block, workspace) => {
      if (changed) return;
      changed = true;

      if (mutation === 'variable') workspace.getVariableMap().createVariable('Injected');
      else workspace.newBlock('settlement_probe');
    });

    assert.throws(() => f.dependencies.settle(), { code: 'ABS_NATIVE_UI_CONTRACT_CHANGED' });
    assert.equal(f.snapshots(), 4);
  });
});


for (const requested of ['requested', 'unavailable']) {
  test(`ordinary saved-state loading verifies the actual requested dropdown value: ${requested}`, t => {
    const workspace = new Blockly.Workspace();
    const type = 'saved_dependency_probe';
    let ready = false;

    Blockly.Blocks[type] = {
      init() {
        this.appendDummyInput().appendField(new Blockly.FieldDropdown(() => ready
          ? [['Default', 'default'], ['Requested', 'requested']]
          : [['Default', 'default']]), 'CHOICE');
      },
    };

    const unregister = registerNativeFieldInitializer(() => workspace, () => {
      ready = true;
      for (const block of workspace.getAllBlocks(false)) block.getField('CHOICE').getOptions(false);
    });
    const input = { blocks: { blocks: Array.from({ length: 17 }, (_, id) => ({
      id: String(id), type, fields: { CHOICE: requested }, deletable: false,
    })) } };
    const saved = JSON.stringify(input);

    t.after(() => {
      unregister();
      workspace.dispose();
      delete Blockly.Blocks[type];
    });

    const load = () => withNativeStateLoading(Blockly, workspace, input,
      () => Blockly.serialization.workspaces.load(input, workspace));

    if (requested === 'unavailable') assert.throws(load, { code: 'ABS_FIELD_OPTION_INVALID' });
    else {
      load();
      assert.equal(workspace.getAllBlocks(false).length, 17);
      assert.ok(workspace.getAllBlocks(false).every(block => block.getFieldValue('CHOICE') === requested && !block.isDeletable()));
    }

    assert.equal(JSON.stringify(input), saved);
  });
}

test('large real Blockly workspaces keep full phase readback without per-callback scans', async t => {
  const workspace = new Blockly.Workspace();
  const type = 'large_phase_probe';

  Blockly.Blocks[type] = {
    init() { this.appendDummyInput().appendField(new Blockly.FieldNumber(1), 'VALUE'); },
  };

  t.after(() => { workspace.dispose(); delete Blockly.Blocks[type]; });

  const blocks = Array.from({ length: 2400 }, () => workspace.newBlock(type));
  const queue = new NativeUiTasks(undefined, () => 0);
  let snapshots = 0;

  for (let i = 0; i < 162; i++) queue.set(() => blocks[i].setTooltip('ready'));

  await queue.drainCooperatively(() => {
    snapshots++;
    return nativeUiSemanticSnapshot(Blockly, workspace);
  }, async () => {}, () => {});

  assert.equal(snapshots, 2);
  assert.equal(workspace.getAllBlocks(false).length, blocks.length);
});
