import * as Blockly from 'blockly';
import { bindNativeAbs } from '../../../editors/blockly-editor/services/blockly-native-abs-binding';
import { NativeCandidateWorkspace } from '../../../editors/blockly-editor/services/blockly-native-candidate-workspace';
import { prepareNativeModels } from '../../../editors/blockly-editor/services/blockly-native-model-preparation';
import { createNativeStructureObserver } from '../../../editors/blockly-editor/services/blockly-native-structure';
import { createAbsProjection, indexAbsSyntax } from './abs-identity-map';
import { inactiveAbsSyntax, retainedInactiveAbsCalls } from './abs-native-preservation';
import { parseAbsSyntax, readAbsSyntax } from './abs-syntax';
import { captureAbsWorkspaceState } from './abs-workspace-state';
import type { AbsSyntaxNode } from './abs-state';

describe('native model preparation activity masking', () => {
  const scopeType = 'model_mask_scope', initializerType = 'model_mask_initializer', scanType = 'model_mask_scan';
  const reason = 'ABS_NATIVE_MODEL_PREPARATION';
  const source = '# ABS Schema: 2\n' + `${scopeType}() @disabled\n    @DO:\n        ${initializerType}(NAME="sleep")\n${scanType}()`;
  const workspaces: Blockly.Workspace[] = [];
  let previousRuntime: typeof Blockly | undefined;
  const workspace = () => { const value = new Blockly.Workspace(); workspaces.push(value); return value; };
  const execution = (value: Blockly.Workspace) => new NativeCandidateWorkspace(Blockly, value, createNativeStructureObserver(), () => {});
  const generator = (scanInInit: boolean, registrations: string[] = []) => {
    const value = new Blockly.Generator('model-mask-test') as Blockly.Generator & {
      registerVariableToBlockly(name: string, type: string): void;
    };
    value.registerVariableToBlockly = name => { registrations.push(name); };
    const scan = (current: Blockly.Workspace) => {
      for (const block of current.getAllBlocks(false)) {
        if (block.type === initializerType && block.isEnabled() && !block.getInheritedDisabled()) {
          value.forBlock[initializerType].call(value, block, value);
        }
      }
    };
    value.init = current => { if (scanInInit) scan(current); };
    value.forBlock[initializerType] = block => {
      value.registerVariableToBlockly(block.getFieldValue('NAME'), 'Device'); return '';
    };
    value.forBlock[scanType] = block => { if (!scanInInit) scan(block.workspace); return ''; };
    value.forBlock[scopeType] = (block, current) => current.statementToCode(block, 'DO');
    return value;
  };
  const detachedInactive = () => {
    const syntax = parseAbsSyntax(source), nodes = indexAbsSyntax(syntax).map(entry => entry.node);
    const value = workspace(), child = value.newBlock(initializerType), active = value.newBlock(scanType);
    child.setFieldValue('sleep', 'NAME');
    const blocks = new Map<AbsSyntaxNode, Blockly.Block>([
      [nodes.find(node => node.type === initializerType)!, child], [nodes.find(node => node.type === scanType)!, active],
    ]);
    return { value, child, active, blocks, inactiveNodes: inactiveAbsSyntax(syntax) };
  };

  beforeEach(() => {
    previousRuntime = window['Blockly']; window['Blockly'] = Blockly;
    Blockly.Blocks[scopeType] = { init() { this.appendStatementInput('DO'); this.setNextStatement(true); } };
    Blockly.Blocks[initializerType] = { init() {
      this.appendDummyInput().appendField(new Blockly.FieldTextInput('device'), 'NAME');
      this.setPreviousStatement(true); this.setNextStatement(true);
    } };
    Blockly.Blocks[scanType] = { init() { this.appendDummyInput(); } };
  });
  afterEach(() => {
    for (const value of workspaces.splice(0)) value.dispose();
    for (const type of [scopeType, initializerType, scanType]) delete Blockly.Blocks[type];
    if (previousRuntime === undefined) delete window['Blockly']; else window['Blockly'] = previousRuntime;
  });

  for (const scanInInit of [true, false]) {
    const label = scanInInit ? 'generator.init' : 'an active generator';
    it(`keeps inherited inactive children invisible to ${label} workspace scans even without their preserved parent`, () => {
      const full = workspace(), parent = full.newBlock(scopeType), fullChild = full.newBlock(initializerType);
      full.newBlock(scanType); parent.getInput('DO')!.connection!.connect(fullChild.previousConnection!);
      parent.setDisabledReason(true, 'MANUALLY_DISABLED');
      const canonical: string[] = [];
      generator(scanInInit, canonical).workspaceToCode(full);
      expect(canonical).toEqual([]);

      const fixture = detachedInactive(), registrations: string[] = [];
      expect(fixture.child.getSurroundParent()).toBeNull();
      expect(fixture.child.isEnabled()).toBeTrue();
      const result = prepareNativeModels(execution(fixture.value), generator(scanInInit, registrations), fixture.blocks,
        () => new Set(), 'model-mask-test', { inactiveNodes: fixture.inactiveNodes });
      expect(result).toEqual([]); expect(registrations).toEqual([]);
      expect(fixture.value.getVariableMap().getAllVariables()).toEqual([]);
      expect(fixture.child.isEnabled()).toBeTrue();
      expect([...fixture.child.getDisabledReasons()]).toEqual([]);
      expect(JSON.stringify(Blockly.serialization.workspaces.save(fixture.value))).not.toContain(reason);
    });

    it(`binds a real preserved disabled parent and a new inactive initializer with ${label} scanning`, async () => {
      const original = workspace();
      original.newBlock(scopeType, 'kept-scope').setDisabledReason(true, 'MANUALLY_DISABLED');
      const captured = captureAbsWorkspaceState(original, () => {});
      const baseline = await createAbsProjection(captured.state, { document: captured.state, contracts: captured.contracts,
        generation: 'model-mask-test', baselineRef: 'model-mask-test', scope: { projectKey: 'isolated', pageId: 'main' }, savedAbiHash: null });
      const hostCalls = retainedInactiveAbsCalls(baseline, readAbsSyntax(source));
      expect(hostCalls.map(call => call.type)).toEqual([scopeType]);
      const scratch = workspace(), registrations: string[] = [];
      const read = bindNativeAbs(source, execution(scratch), new Map(), undefined, value => value, hostCalls,
        { generator: generator(scanInInit, registrations), requestId: 'model-mask-binding' });
      const result = read();
      expect(result.binding!.modelDeclarations ?? []).toEqual([]);
      expect(registrations).toEqual([]);
      expect(scratch.getAllBlocks(false).map(block => block.type).sort()).toEqual([initializerType, scanType].sort());
      expect(scratch.getAllBlocks(false).every(block => block.isEnabled() && !block.hasDisabledReason(reason))).toBeTrue();
      expect(JSON.stringify(result.state)).not.toContain(reason);
      expect(original.getBlockById('kept-scope')!.hasDisabledReason('MANUALLY_DISABLED')).toBeTrue();
    });
  }

  for (const failInInit of [true, false]) it(`removes only its own masks after an exception in ${failInInit ? 'init' : 'a generator'}`, () => {
    const fixture = detachedInactive(), current = generator(false);
    const existing = fixture.value.newBlock(initializerType);
    existing.setDisabledReason(true, 'MANUALLY_DISABLED'); existing.setDisabledReason(true, reason);
    const originalReasons = [...existing.getDisabledReasons()];
    const fail = () => {
      expect(fixture.child.hasDisabledReason(reason)).toBeTrue();
      throw new Error('isolated generator failure');
    };
    if (failInInit) current.init = fail;
    else current.forBlock[scanType] = fail;
    expect(() => prepareNativeModels(execution(fixture.value), current, fixture.blocks,
      () => new Set(), 'model-mask-failure', { inactiveNodes: fixture.inactiveNodes })).toThrowError('isolated generator failure');
    expect(fixture.child.isEnabled()).toBeTrue();
    expect([...fixture.child.getDisabledReasons()]).toEqual([]);
    expect([...existing.getDisabledReasons()]).toEqual(originalReasons);
  });

  it('preserves unrelated existing disable reasons on an inherited inactive native instance', () => {
    const fixture = detachedInactive(), current = generator(true);
    fixture.child.setDisabledReason(true, 'LIBRARY_DISABLED');
    fixture.child.setDisabledReason(true, reason);
    const before = [...fixture.child.getDisabledReasons()];
    expect(prepareNativeModels(execution(fixture.value), current, fixture.blocks, () => new Set(), 'model-mask-existing',
      { inactiveNodes: fixture.inactiveNodes })).toEqual([]);
    expect([...fixture.child.getDisabledReasons()]).toEqual(before);
  });

  it('does not mask an active next initializer following a disabled predecessor', () => {
    const syntax = parseAbsSyntax('# ABS Schema: 2\n' + `${initializerType}(NAME="sleep") @disabled\n    @next:\n        ${initializerType}(NAME="live")`);
    const [firstNode, nextNode] = indexAbsSyntax(syntax).map(entry => entry.node);
    const value = workspace(), first = value.newBlock(initializerType), next = value.newBlock(initializerType);
    first.setFieldValue('sleep', 'NAME'); next.setFieldValue('live', 'NAME');
    first.nextConnection!.connect(next.previousConnection!);
    const current = generator(true), registrations: string[] = [];
    current.registerVariableToBlockly = name => { registrations.push(name); };
    const result = prepareNativeModels(execution(value), current, new Map([[firstNode, first], [nextNode, next]]),
      () => new Set(), 'model-mask-next', { inactiveNodes: inactiveAbsSyntax(syntax) });
    expect(result.map(effect => effect.name)).toEqual(['live']);
    expect(registrations.length).toBeGreaterThan(0);
    expect(registrations.every(name => name === 'live')).toBeTrue();
    expect(first.isEnabled()).toBeTrue(); expect(next.isEnabled()).toBeTrue();
    expect([...first.getDisabledReasons()]).toEqual([]); expect([...next.getDisabledReasons()]).toEqual([]);
  });

  it('still rejects an explicit registration from an inactive initializer despite masking', () => {
    const fixture = detachedInactive(), current = generator(false);
    current.forBlock[scanType] = () => {
      current.forBlock[initializerType].call(current, fixture.child, current); return '';
    };
    expect(() => prepareNativeModels(execution(fixture.value), current, fixture.blocks, () => new Set(), 'model-mask-owner',
      { inactiveNodes: fixture.inactiveNodes })).toThrowMatching(error => error.code === 'ABS_MODEL_DECLARATION_UNOWNED');
    expect(fixture.value.getVariableMap().getAllVariables()).toEqual([]);
    expect(fixture.child.isEnabled()).toBeTrue();
  });
});
