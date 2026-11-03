import * as Blockly from 'blockly';
import { ABS_MANUAL_DISABLED_REASON, readAbsBlockStateRequest, planAbsBlockStateChanges,
  type AbsBlockStateUpdateRequest } from './abs-block-state';
import { inspectLiveBlockStates, prepareLiveBlockStateOperation } from '../../../editors/blockly-editor/services/blockly-block-state-operation';
import type { AbsAbiWorkspace } from './abs-state';

describe('explicit existing Blockly block state operations', () => {
  const request = (changes: AbsBlockStateUpdateRequest['changes']): AbsBlockStateUpdateRequest => ({
    version: 2, requestId: 'state-request-000001', action: 'update', expectedGeneration: 'generation-1', changes,
  });
  const initial = (): AbsAbiWorkspace => ({ variables: [{ id: 'model', name: 'sensor', type: 'Sensor' }], blocks: { blocks: [
    { id: 'a', type: 'state_fixture', fields: { TEXT: 'keep' }, extraState: { data: [1, false] }, disabledReasons: ['LIBRARY_RULE'], collapsed: true },
    { id: 'b', type: 'state_fixture', disabledReasons: [ABS_MANUAL_DISABLED_REASON, 'OTHER_LIBRARY'] },
  ] } });
  for (const input of [null, {}, { version: 1 },
    { ...request([{ blockId: 'a', disabled: true }]), extra: true },
    { ...request([{ blockId: 'a', disabled: true }]), expectedCanvas: 'also-authorized' },
    { ...request([{ blockId: 'a', disabled: true }]), expectedGeneration: undefined },
    request([]), request([{ blockId: 'a' }]), request([{ blockId: 'a', disabled: null as any }]),
    request([{ blockId: 'a', disabled: true }, { blockId: 'a', collapsed: true }]),
    request([{ blockId: 'a', disabledReasons: [] } as any]),
    request([{ blockId: 'a', editable: true } as any]),
    { version: 2, requestId: 'state-request-000001', action: 'inspect', changes: [] },
    { version: 2, requestId: 'state-request-000001', action: 'inspect', limit: 0 },
    { version: 2, requestId: 'state-request-000001', action: 'inspect', blockIds: ['a', 'a'] },
  ]) it('rejects malformed or broadened state authority before native work: ' + JSON.stringify(input), () => {
    expect(() => readAbsBlockStateRequest(input)).toThrow();
  });

  it('accepts an opaque first-baseline inspection token without inventing a generation', () => {
    const input = { version: 2, requestId: 'state-request-000001', action: 'update',
      expectedCanvas: 'inspected-canvas', changes: [{ blockId: 'a', disabled: true }] };
    expect(readAbsBlockStateRequest(input)).toEqual(input as any);
  });

  it('plans changes without mutating any input or changing models, fields, extras or library reasons', () => {
    const workspace = initial(), before = JSON.stringify(workspace);
    const plan = planAbsBlockStateChanges(workspace, request([{ blockId: 'a', disabled: true, collapsed: false }, { blockId: 'b', disabled: false }]));
    expect(JSON.stringify(workspace)).toBe(before);
    expect(plan.workspace['variables']).toEqual(workspace['variables']);
    expect(plan.workspace.blocks.blocks[0].fields).toEqual(workspace.blocks.blocks[0].fields);
    expect(plan.workspace.blocks.blocks[0].extraState).toEqual(workspace.blocks.blocks[0].extraState);
    expect(plan.states[0]).toEqual(jasmine.objectContaining({ manualDisabled: true, collapsed: false, disabledReasons: ['LIBRARY_RULE', ABS_MANUAL_DISABLED_REASON] }));
    expect(plan.states[1]).toEqual(jasmine.objectContaining({ disabled: true, manualDisabled: false, disabledReasons: ['OTHER_LIBRARY'] }));
    expect(plan.changed).toBeTrue();
  });
  it('keeps a no-op plan unchanged', () => {
    const workspace = initial();
    const plan = planAbsBlockStateChanges(workspace, request([{ blockId: 'a', disabled: false, collapsed: true }]));
    expect(plan.changed).toBeFalse(); expect(plan.workspace).toEqual(workspace);
  });
  for (const edit of ['locked', 'missing'] as const) it('preflights the complete batch before changing a detached candidate: ' + edit, () => {
    const workspace = initial(), before = JSON.stringify(workspace);
    if (edit === 'locked') workspace.blocks.blocks[1]['editable'] = false;
    const input = JSON.stringify(workspace);
    expect(() => planAbsBlockStateChanges(workspace, request([{ blockId: 'a', disabled: true }, { blockId: edit === 'locked' ? 'b' : 'missing', collapsed: true }]))).toThrow();
    expect(JSON.stringify(workspace)).toBe(input); expect(before).toContain('keep');
  });

  describe('native live setters', () => {
    let workspace: Blockly.Workspace;
    beforeEach(() => {
      Blockly.Blocks['state_fixture'] = { init() { this.appendDummyInput().appendField(new Blockly.FieldTextInput('keep'), 'TEXT'); } };
      workspace = new Blockly.Workspace(); Blockly.Events.disable();
      workspace.newBlock('state_fixture', 'a'); workspace.newBlock('state_fixture', 'b');
      workspace.getBlockById('a')!.setDisabledReason(true, 'LIBRARY_RULE');
    });
    afterEach(() => { workspace.dispose(); Blockly.Events.enable(); delete Blockly.Blocks['state_fixture']; });
    const snapshot = (value: Blockly.Workspace) => Blockly.serialization.workspaces.save(value) as AbsAbiWorkspace;
    const plan = (changes: AbsBlockStateUpdateRequest['changes']) => planAbsBlockStateChanges(snapshot(workspace), request(changes));
    it('applies and restores only tracked manual/collapse state, preserving all instances', () => {
      const a = workspace.getBlockById('a')!, b = workspace.getBlockById('b')!;
      const operation = prepareLiveBlockStateOperation(workspace, plan([{ blockId: 'a', disabled: true }, { blockId: 'b', collapsed: true }]), () => {});
      operation.apply(); expect(a.getDisabledReasons().has(ABS_MANUAL_DISABLED_REASON)).toBeTrue(); expect(b.isCollapsed()).toBeTrue();
      a.setDisabledReason(true, 'NEW_LIBRARY_RULE');
      operation.restore();
      expect(workspace.getBlockById('a')).toBe(a); expect(a.getDisabledReasons().has(ABS_MANUAL_DISABLED_REASON)).toBeFalse();
      expect([...a.getDisabledReasons()]).toEqual(['LIBRARY_RULE', 'NEW_LIBRARY_RULE']); expect(b.isCollapsed()).toBeFalse();
    });
    it('never claims that clearing manual state enables a block still disabled by a library', () => {
      const a = workspace.getBlockById('a')!; a.setDisabledReason(true, ABS_MANUAL_DISABLED_REASON);
      const result = prepareLiveBlockStateOperation(workspace, plan([{ blockId: 'a', disabled: false }]), () => {}).apply();
      expect(result[0].manualDisabled).toBeFalse(); expect(result[0].disabled).toBeTrue(); expect(result[0].disabledReasons).toEqual(['LIBRARY_RULE']);
    });
    it('does not restore a state property that this operation never changed', () => {
      const a = workspace.getBlockById('a')!;
      const operation = prepareLiveBlockStateOperation(workspace, plan([{ blockId: 'a', collapsed: true }]), () => {});
      operation.apply(); a.setDisabledReason(true, ABS_MANUAL_DISABLED_REASON);
      operation.restore();
      expect(a.isCollapsed()).toBeFalse();
      expect(a.getDisabledReasons().has(ABS_MANUAL_DISABLED_REASON)).toBeTrue();
    });
    it('rejects a later locked target before invoking any earlier setter', () => {
      const a = workspace.getBlockById('a')!, b = workspace.getBlockById('b')!;
      const prepared = plan([{ blockId: 'a', disabled: true }, { blockId: 'b', collapsed: true }]);
      const setter = spyOn(a, 'setDisabledReason').and.callThrough(); b.setEditable(false);
      expect(() => prepareLiveBlockStateOperation(workspace, prepared, () => {})).toThrow(); expect(setter).not.toHaveBeenCalled();
    });
    it('rejects stale state and replaced instances before the first mutation', () => {
      const prepared = plan([{ blockId: 'a', disabled: true }]);
      const operation = prepareLiveBlockStateOperation(workspace, prepared, () => {});
      workspace.getBlockById('a')!.setDisabledReason(true, 'LATER_RULE');
      expect(() => operation.apply()).toThrow();
      workspace.getBlockById('a')!.dispose(false); workspace.newBlock('state_fixture', 'a');
      expect(() => operation.restore()).toThrow();
    });
    it('can restore earlier tracked mutations after a later native setter throws', () => {
      const operation = prepareLiveBlockStateOperation(workspace, plan([{ blockId: 'a', disabled: true }, { blockId: 'b', collapsed: true }]), () => {});
      spyOn(workspace.getBlockById('b')!, 'setCollapsed').and.throwError('injected native setter');
      expect(() => operation.apply()).toThrow(); operation.restore();
      expect([...workspace.getBlockById('a')!.getDisabledReasons()]).toEqual(['LIBRARY_RULE']);
    });
    it('does not undo a later target property whose setter was never reached', () => {
      const a = workspace.getBlockById('a')!, b = workspace.getBlockById('b')!;
      const operation = prepareLiveBlockStateOperation(workspace, plan([{ blockId: 'a', disabled: true }, { blockId: 'b', collapsed: true }]), () => {});
      const original = a.setDisabledReason.bind(a);
      spyOn(a, 'setDisabledReason').and.callFake((disabled, reason) => {
        original(disabled, reason);
        if (disabled && reason === ABS_MANUAL_DISABLED_REASON) { b.setCollapsed(true); throw new Error('untracked callback'); }
      });
      expect(() => operation.apply()).toThrow(); operation.restore();
      expect(a.getDisabledReasons().has(ABS_MANUAL_DISABLED_REASON)).toBeFalse();
      expect(b.isCollapsed()).toBeTrue(); // Coordinator readback must report this unowned change, not silently erase it.
    });
    it('discovers bounded exact IDs with intersecting filters and no field or serializer access', () => {
      const a = workspace.getBlockById('a')!;
      const getter = spyOn(a, 'getFieldValue').and.throwError('not an ID discovery operation');
      const parsed = readAbsBlockStateRequest({ version: 2, requestId: 'state-request-000001', action: 'inspect', blockIds: ['b', 'a'], blockTypes: ['state_fixture'], limit: 1 });
      if (parsed.action !== 'inspect') throw new Error('unexpected request');
      const result = inspectLiveBlockStates(workspace, parsed);
      expect(result.totalMatches).toBe(2); expect(result.instances[0].blockId).toBe('a'); expect(result.truncated).toBeTrue(); expect(getter).not.toHaveBeenCalled();
    });
  });
});
