import * as Blockly from 'blockly';
import { NativeUiTasks, nativeUiSemanticSnapshot } from '../../../editors/blockly-editor/services/blockly-native-ui-tasks';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { assertNativeGenerationStable } from '../../../editors/blockly-editor/services/blockly-native-generation-evidence';

describe('native deferred UI effect boundary', () => {
  it('does not treat layout-different generation inputs as identical program output evidence', () => {
    const workspace = new Blockly.Workspace(), generator = new Blockly.CodeGenerator('layout-proof');
    Blockly.Blocks['layout_order_probe'] = { init() { this.appendDummyInput(); } };
    generator.forBlock['layout_order_probe'] = block => block.id + ';\n';
    try {
      Blockly.serialization.workspaces.load({ blocks: { blocks: [
        { type: 'layout_order_probe', id: 'existing', x: 30, y: 500 },
        { type: 'layout_order_probe', id: 'new', x: 30, y: 130 },
      ] } }, workspace);
      const before = generator.workspaceToCode(workspace);
      workspace.getBlockById('new')!.moveBy(0, 600);
      const after = generator.workspaceToCode(workspace);
      expect(before).toBe('new;\n\nexisting;\n'); expect(after).toBe('existing;\n\nnew;\n');
      // No fields, models, connections or IDs changed. Comparing raw code across
      // these layouts would reject an ordinary host placement of a new root.
      expect(before).not.toBe(after);
    } finally { workspace.dispose(); delete Blockly.Blocks['layout_order_probe']; }
  });
  it('checks each callback even when a later callback would restore the mutation', () => {
    const tasks = new NativeUiTasks(); let state = 'before', calls = 0;
    tasks.set(() => { state = 'changed'; calls++; });
    tasks.set(() => { state = 'before'; calls++; });
    expect(() => tasks.drain(() => state)).toThrowError(/changed persisted state/);
    expect(calls).toBe(1);
  });
  it('bounds callback work after cancellations and shares adjacent semantic snapshots', () => {
    const tasks = new NativeUiTasks(); let snapshots = 0;
    for (let i = 0; i < 512; i++) tasks.set(() => {});
    tasks.drain(() => { snapshots++; return 'same'; });
    expect(snapshots).toBe(513);
    expect(() => tasks.set(() => {})).toThrowError(/finite callback/);
    const cancelled = new NativeUiTasks();
    for (let i = 0; i < 512; i++) cancelled.clear(cancelled.set(() => {}));
    expect(() => cancelled.set(() => {})).toThrowError(/finite callback/);
  });
  for (const storage of ['generator', 'closure', 'global'])
  it('isolates first-generation state across UI verification passes: ' + storage, async () => {
    const counter = storage === 'generator' ? 'Arduino.callbackCounter' : storage === 'global' ? 'globalThis.callbackCounter' : 'callbackCounter';
    const input: NativeCandidateRequest = { blocks: [], steps: [{ kind: 'context', mode: 'arduino' }, {
      kind: 'script', label: 'stateful-callback-library', source: `
        let callbackCounter = 0;
        Blockly.Blocks.callback_owner = { init() { this.appendDummyInput(); setTimeout(() => this.setTooltip('ready'), 0); } };
        Arduino.forBlock.callback_owner = () => {
          ${counter} = (${counter} || 0) + 1;
          Arduino.addFunction('callback', 'void callback_' + ${counter} + '() {}'); return '';
        };
      `,
    }], verify: { state: { blocks: { blocks: [{ id: 'owner', type: 'callback_owner', x: 0, y: 0 }] } }, contracts: { fields: { owner: {} } } } };
    const first = await evaluateNativeCandidate(input, { assertCurrent() {} });
    const second = await evaluateNativeCandidate(input, { assertCurrent() {} });
    expect(first.state).toEqual(second.state);
    expect(first.generationEvidence).toBeUndefined();
    expect(input.verify!.uiPhase).toBeUndefined();
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });

  it('reports the first differing output without claiming an ABS model or identity failure', () => {
    try {
      assertNativeGenerationStable({ code: 'same\nfirst', artifacts: [], deferredUi: true },
        { code: 'same\nsecond', artifacts: [], deferredUi: true });
      fail('accepted changed code');
    } catch (error: any) {
      expect(error.code).toBe('ABS_GENERATION_UNSTABLE');
      expect(error.message).toContain('line 2');
      expect(error.diagnostic.received).toBe('before: first; after: second');
    }
  });
  it('allows dropdown labels but rejects changed option keys and number constraints', () => {
    const workspace = new Blockly.Workspace();
    Blockly.Blocks['ui_task_test'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldDropdown([['label', 'A'], ['second', 'B']]), 'MODE')
        .appendField(new Blockly.FieldNumber(1, 0, 10), 'COUNT');
    } };
    try {
      const block = workspace.newBlock('ui_task_test');
      const snapshot = () => nativeUiSemanticSnapshot(Blockly, workspace);
      const tasks = new NativeUiTasks();
      tasks.set(() => { (block.getField('MODE') as any).menuGenerator_ = [['new label', 'A'], ['second', 'B']]; });
      tasks.drain(snapshot);
      for (const effect of [() => (block.getField('COUNT') as Blockly.FieldNumber).setMax(9),
        () => { (block.getField('MODE') as any).menuGenerator_ = [['new label', 'A']]; }]) {
        const rejected = new NativeUiTasks(); rejected.set(effect);
        expect(() => rejected.drain(snapshot)).toThrowError(/field constraints/);
      }
    } finally { workspace.dispose(); delete Blockly.Blocks['ui_task_test']; }
  });

  it('rejects timers scheduled by inspection, including caught errors', () => {
    const tasks = new NativeUiTasks(); tasks.set(() => {});
    expect(() => tasks.drain(() => { try { tasks.set(() => {}); } catch {} return 'state'; })).toThrow();
  });

  for (const scenario of ['code', 'artifact', 'generation-timer'])
  it('checks generated code and artifacts as well as serialized state: ' + scenario, async () => {
    const effect = scenario === 'generation-timer' ? 'try { setTimeout(() => {}, 0); } catch {}' : 'marker = 2';
    const duringGenerator = effect.includes('setTimeout');
    const input: NativeCandidateRequest = { blocks: [], steps: [{ kind: 'context', mode: 'arduino' }, {
      kind: 'script', label: 'ui-code-effect', source: `
        let marker = 1;
        Blockly.Blocks.ui_code_effect = { init() { this.appendDummyInput(); ${duringGenerator ? '' : `setTimeout(() => { ${effect}; }, 0);`} } };
        Arduino.forBlock.ui_code_effect = () => { ${duringGenerator ? effect : ''}; Arduino.addSetup('marker', ${scenario === 'artifact' ? '"constant"' : 'String(marker)'} + ';'); return ''; };
        ${scenario === 'artifact' ? `Arduino.getGeneratedArtifacts = () => [{fileName:'variables_marker-12345678.h',content:String(marker),sourceTag:'marker'}];` : ''}
      `,
    }], verify: { state: { blocks: { blocks: [{ id: 'owner', type: 'ui_code_effect', x: 0, y: 0 }] } }, contracts: { fields: { owner: {} } } } };
    await expectAsync(evaluateNativeCandidate(input, { assertCurrent() {} })).toBeRejectedWithError(duringGenerator ? /timers during generation/ : /changed generated code/);
  });
});
