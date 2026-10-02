import * as Blockly from 'blockly';
import { captureNativeBlock } from '../../../editors/blockly-editor/services/blockly-native-instance';
import { nativeCandidateBudget, nativeCandidateTimeout, NATIVE_CANDIDATE_PHASES } from '../../../editors/blockly-editor/services/blockly-native-progress';
import { restoreAbsFailure, serializeAbsFailure } from './abs-diagnostics';
import { bindNativeAbs } from '../../../editors/blockly-editor/services/blockly-native-abs-binding';
import { NativeCandidateWorkspace } from '../../../editors/blockly-editor/services/blockly-native-candidate-workspace';
import { createNativeStructureObserver } from '../../../editors/blockly-editor/services/blockly-native-structure';
import { prepareNativeModels } from '../../../editors/blockly-editor/services/blockly-native-model-preparation';
import type { AbsSyntaxNode } from './abs-state';

describe('native candidate performance boundaries', () => {
  it('parses detached declaration syntax once per type and keeps two complete binding readbacks', () => {
    const definition = { type: 'abs_binding_probe', message0: '%1', args0: [{ type: 'field_input', name: 'TEXT', text: '' }], output: null };
    let declarationsRead = 0;
    const declaration = { ...definition };
    Object.defineProperty(declaration, 'args0', { enumerable: true, get() { declarationsRead++; return definition.args0; } });
    const run = (count: number) => {
      // Each production binding runs in a fresh realm/registry. Do not nest
      // observers from earlier runs on this test's shared host registration.
      Blockly.Blocks[definition.type] = { init() { this.jsonInit(definition); } };
      const workspace = new Blockly.Workspace();
      try {
        const execution = new NativeCandidateWorkspace(Blockly, workspace, createNativeStructureObserver(), () => {});
        const readback = spyOn(execution, 'result').and.callThrough();
        declarationsRead = 0;
        const finish = bindNativeAbs('# ABS Schema: 2\n' + Array.from({ length: count }, (_, i) => `abs_binding_probe("value-${i}")`).join('\n'),
          execution, new Map([[definition.type, declaration]]));
        const reads = declarationsRead;
        const result = finish();
        expect(readback).toHaveBeenCalledTimes(2);
        expect(result.binding!.instances.length).toBe(count);
        expect(result.state['blocks'].blocks.map(block => block.fields.TEXT)).toEqual(
          Array.from({ length: count }, (_, i) => `value-${i}`));
        return reads;
      } finally { workspace.dispose(); }
    };
    try {
      const once = run(1);
      expect(once).toBeGreaterThan(0);
      expect(run(20)).toBe(once);
      // Another candidate must read its own declaration, not a process/type cache.
      expect(run(1)).toBe(once);
    } finally { delete Blockly.Blocks[definition.type]; }
  });

  it('rejects contract getters that mutate state between the two binding readbacks', () => {
    Blockly.Blocks['abs_binding_effect'] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('value'), 'TEXT');
    } };
    const workspace = new Blockly.Workspace();
    try {
      const observer = createNativeStructureObserver();
      const execution = new NativeCandidateWorkspace(Blockly, workspace, observer, () => {});
      const finish = bindNativeAbs('# ABS Schema: 2\nabs_binding_effect("value")', execution, new Map());
      const read = observer.readNativeBlockJson;
      spyOn(observer, 'readNativeBlockJson').and.callFake(block => {
        block.setFieldValue('changed', 'TEXT'); return read(block);
      });
      expect(finish).toThrowError(/changed|overwrote/i);
    } finally { workspace.dispose(); delete Blockly.Blocks['abs_binding_effect']; }
  });

  for (const pending of [false, true]) it(`avoids empty dependency scans but preserves live unresolved dependencies (${pending})`, () => {
    Blockly.Blocks['abs_ready_parent'] = { init() { this.appendValueInput('VALUE'); } };
    Blockly.Blocks['abs_ready_child'] = { init() { this.setOutput(true); } };
    Blockly.Blocks['abs_ready_producer'] = { init() {} };
    const workspace = new Blockly.Workspace(), previous = Object.getOwnPropertyDescriptor(window, 'registerVariableToBlockly');
    try {
      window['registerVariableToBlockly'] = () => {};
      const parent = workspace.newBlock('abs_ready_parent'), child = workspace.newBlock('abs_ready_child');
      const producer = workspace.newBlock('abs_ready_producer');
      parent.getInput('VALUE')!.connection!.connect(child.outputConnection!);
      const descendants = spyOn(child, 'getDescendants').and.callThrough();
      const generator = new Blockly.Generator('abs-ready');
      generator.init = () => {};
      let unresolved = pending;
      const visited: string[] = [];
      for (const block of [parent, child, producer]) generator.forBlock[block.type] = () => {
        visited.push(block.type);
        if (block === producer) unresolved = false;
        return '';
      };
      const execution = new NativeCandidateWorkspace(Blockly, workspace, createNativeStructureObserver(), () => {});
      const nodes = new Map([parent, child, producer].map((block, start) => [{ start, fields: {} } as AbsSyntaxNode, block]));
      expect(prepareNativeModels(execution, generator, nodes,
        () => new Set(unresolved ? [child] : []), 'request')).toEqual([]);
      expect(visited).toEqual(pending ? [producer.type, parent.type, child.type] : [parent.type, child.type, producer.type]);
      if (pending) expect(descendants).toHaveBeenCalled();
      else expect(descendants).not.toHaveBeenCalled();
      expect(window['registerVariableToBlockly']).toBeDefined();
    } finally {
      if (previous) Object.defineProperty(window, 'registerVariableToBlockly', previous); else delete window['registerVariableToBlockly'];
      workspace.dispose();
      for (const type of ['abs_ready_parent', 'abs_ready_child', 'abs_ready_producer']) delete Blockly.Blocks[type];
    }
  });
  it('bounds each fresh realm and preserves caller-supplied overall deadlines', () => {
    expect(nativeCandidateBudget(undefined, 1)).toEqual({ perPassMs: 10000, totalMs: 10000 });
    expect(nativeCandidateBudget(undefined, 2)).toEqual({ perPassMs: 10000, totalMs: 20000 });
    expect(nativeCandidateBudget(3000, 2)).toEqual({ perPassMs: 3000, totalMs: 3000 });
    for (const value of [0, -1, NaN, Infinity, 60001]) expect(() => nativeCandidateBudget(value, 2)).toThrowError(/Invalid/);
  });
  it('captures only block-local seed data without visiting the descendant graph', () => {
    Blockly.Blocks['abs_seed_probe'] = { init() { this.appendDummyInput().appendField(new Blockly.FieldTextInput('value'), 'TEXT'); } };
    const workspace = new Blockly.Workspace();
    try {
      const block = workspace.newBlock('abs_seed_probe', 'owner');
      const child = Object.defineProperty({ id: 'child', type: 'abs_seed_probe' }, 'fields', {
        enumerable: true, get() { throw new Error('descendant traversal'); },
      });
      const definition = { type: block.type, message0: '%1', args0: [{ type: 'field_input', name: 'TEXT' }] };
      const execution = { native: Blockly, observer: {
        readNativeBlockStructure: () => block.inputList.map(input => ({ input, fields: input.fieldRow })),
        readNativeBlockJson: () => definition,
      } } as any;
      const state = { id: block.id, type: block.type, fields: { TEXT: 'value' }, data: 'metadata', x: 1, y: 2,
        inputs: { VALUE: { block: child } }, next: { block: child } };
      const result = captureNativeBlock(execution, new Map(), block, state);
      expect(result.seed).toEqual({ id: 'owner', type: block.type, fields: { TEXT: 'value' }, data: 'metadata' });
      state.fields.TEXT = 'changed'; expect(result.seed.fields!['TEXT']).toBe('value');
    } finally { workspace.dispose(); delete Blockly.Blocks['abs_seed_probe']; }
  });

  for (const phase of NATIVE_CANDIDATE_PHASES) it('classifies timeout in ' + phase + ' without claiming a syntax or capacity error', () => {
    const result = serializeAbsFailure(restoreAbsFailure(serializeAbsFailure(nativeCandidateTimeout(phase, 10000))));
    expect(result.code).toBe('ABS_NATIVE_TIMEOUT');
    expect(result.diagnostic!.reason).toBe('native-timeout-' + phase);
    expect(result.diagnostic!.hint).toContain('before apply');
    expect(result.diagnostic!.hint).toContain('do not repeat');
    expect(result.diagnostic!.truncated).not.toBeTrue();
  });
});
