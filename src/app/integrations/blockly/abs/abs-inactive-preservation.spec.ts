import * as Blockly from 'blockly';
import { projectDataRuntime } from '@domain/project/project-data/public-api';
import { captureAbsWorkspaceState } from './abs-workspace-state';
import { createAbsProjection, indexAbsSyntax } from './abs-identity-map';
import { createAbsReconciler, reconcileAbsDraft } from './abs-reconciler';
import { prepareAbsNativeReconciliation } from './abs-native-reconciliation';
import { splitAbsState } from './abs-full-state';
import { parseAbsSyntax } from './abs-syntax';
import { absSyntaxOptions } from './abs-syntax-contracts';
import { indexAbsAbi } from './abs-abi-index';
import { assertAbsReadback } from './abs-readback';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { nativeUiSemanticSnapshot } from '../../../editors/blockly-editor/services/blockly-native-ui-tasks';
import type { AbsAbiWorkspace, AbsProjection } from './abs-state';
import type { AbsNativeBinding } from './abs-native-binding';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { modelSteps } from './abs-native-models.fixture';

describe('inactive Blockly data preservation', () => {
  const poisoned = 'inactive_preserved_poison', available = 'inactive_preserved_available';
  const inlineParent = 'inactive_preserved_inline_parent';
  const container = 'inactive_preserved_container', active = 'inactive_preserved_active', value = 'inactive_preserved_value';
  let workspace: Blockly.Workspace;
  let mode: 'throw' | 'mutate-throw';
  const providers = new Map<string, jasmine.Spy>();
  const definition = (type: string) => ({ init() {
    this.appendDummyInput().appendField(new Blockly.FieldTextInput('before'), 'TEXT')
      .appendField(new Blockly.FieldDropdown([['old', 'OLD'], ['new', 'NEW']]), 'MODE');
    this.setPreviousStatement(true); this.setNextStatement(true);
    if (type === inlineParent) this.appendValueInput('VALUE');
    if (type === poisoned || type === inlineParent) {
      const owner = this;
      const provider = jasmine.createSpy('poisoned option provider').and.callFake(() => {
        if (mode === 'mutate-throw') owner.setFieldValue('provider changed canvas', 'TEXT');
        throw Error('inactive option provider is unavailable');
      });
      providers.set(this.id, provider);
      this.getField('MODE').getOptions = provider;
    }
  } });
  const steps: NativeCandidateRequest['steps'] = [{ kind: 'context', mode: 'arduino' }, { kind: 'script', label: 'inactive-field-fixture', source: `
    for (const type of ['${poisoned}', '${available}', '${inlineParent}']) {
      Blockly.Blocks[type] = { init() {
        this.appendDummyInput().appendField(new Blockly.FieldTextInput('before'), 'TEXT')
          .appendField(new Blockly.FieldDropdown([['old','OLD'], ['new','NEW']]), 'MODE');
        this.setPreviousStatement(true); this.setNextStatement(true);
        if (type === '${inlineParent}') this.appendValueInput('VALUE');
        if (type === '${poisoned}' || type === '${inlineParent}') this.getField('MODE').getOptions = function() {
          const failure = new Error('inactive option provider is unavailable');
          failure.message += '\\n' + failure.stack;
          throw failure;
        };
      } };
      Arduino.forBlock[type] = () => '';
    }
    Blockly.Blocks.${active} = { init() { this.appendDummyInput().appendField(new Blockly.FieldNumber(1), 'NUM'); this.setPreviousStatement(true); this.setNextStatement(true); } };
    Arduino.forBlock.${active} = () => '';
    Blockly.Blocks.${value} = { init() { this.appendDummyInput().appendField(new Blockly.FieldNumber(1), 'NUM'); this.setOutput(true); } };
    Arduino.forBlock.${value} = block => [String(block.getFieldValue('NUM')), 0];
    Blockly.Blocks.${container} = { init() { this.appendStatementInput('DO'); this.appendValueInput('VALUE'); this.setNextStatement(true); } };
    Arduino.forBlock.${container} = (block, generator) => generator.statementToCode(block, 'DO');
  ` }];
  const run = (request: Omit<NativeCandidateRequest, 'steps'>, replay = steps) =>
    evaluateNativeCandidate({ ...request, steps: replay }, { assertCurrent() {} });
  const projection = async (): Promise<AbsProjection> => {
    const captured = captureAbsWorkspaceState(workspace, () => {});
    return createAbsProjection(captured.state, { document: captured.state, contracts: captured.contracts,
      generation: 'inactive-fixture', baselineRef: 'inactive-fixture', scope: { projectKey: 'isolated', pageId: 'main' }, savedAbiHash: null });
  };
  const block = (type = poisoned, id = 'kept') => {
    const result = workspace.newBlock(type, id);
    result.setDisabledReason(true, 'MANUALLY_DISABLED'); result.setDisabledReason(true, 'LIBRARY_REASON'); result.setCollapsed(true);
    return result;
  };
  const prepare = (baseline: AbsProjection, source: string, replay = steps) =>
    prepareAbsNativeReconciliation(createAbsReconciler(baseline, source), {}, input => run(input, replay), () => {});
  beforeEach(() => {
    window['Blockly'] = Blockly; workspace = new Blockly.Workspace(); providers.clear(); mode = 'throw';
    Blockly.Blocks[poisoned] = definition(poisoned); Blockly.Blocks[available] = definition(available);
    Blockly.Blocks[inlineParent] = definition(inlineParent);
    Blockly.Blocks[container] = { init() { this.appendStatementInput('DO'); this.appendValueInput('VALUE'); this.setNextStatement(true); } };
    Blockly.Blocks[active] = { init() { this.appendDummyInput().appendField(new Blockly.FieldNumber(1), 'NUM'); this.setPreviousStatement(true); this.setNextStatement(true); } };
    Blockly.Blocks[value] = { init() { this.appendDummyInput().appendField(new Blockly.FieldNumber(1), 'NUM'); this.setOutput(true); } };
    spyOn(projectDataRuntime, 'flushPending').and.resolveTo();
    spyOn(projectDataRuntime, 'prepareValue').and.resolveTo();
  });
  afterEach(() => {
    workspace.dispose(); for (const type of [poisoned, available, inlineParent, container, active, value]) delete Blockly.Blocks[type];
    expect(document.querySelector('[data-blockly-native-candidate]')).toBeNull();
  });

  for (const behavior of ['throw', 'mutate-throw'] as const) it(`does not invoke an inactive ${behavior} provider during capture or UI inspection`, () => {
    mode = behavior; const owner = block();
    const before = Blockly.serialization.workspaces.save(workspace);
    const captured = captureAbsWorkspaceState(workspace, () => {});
    expect(captured.contracts.fields[owner.id]['MODE'].preservedValue).toEqual({ value: 'OLD' });
    expect(() => nativeUiSemanticSnapshot(Blockly, workspace)).not.toThrow();
    expect(providers.get(owner.id)).not.toHaveBeenCalled();
    expect(Blockly.serialization.workspaces.save(workspace)).toEqual(before);
    expect(owner.getFieldValue('TEXT')).toBe('before');
  });

  it('preserves an implicitly inactive input child but still rejects an active next sibling provider', () => {
    const parent = workspace.newBlock(container, 'parent'), child = workspace.newBlock(poisoned, 'child');
    parent.getInput('DO')!.connection!.connect(child.previousConnection!); parent.setDisabledReason(true, 'MANUALLY_DISABLED');
    expect(() => captureAbsWorkspaceState(workspace, () => {})).not.toThrow();
    expect(providers.get(child.id)).not.toHaveBeenCalled();
    const next = workspace.newBlock(poisoned, 'next'); parent.nextConnection!.connect(next.previousConnection!);
    expect(() => captureAbsWorkspaceState(workspace, () => {})).toThrowMatching(error => error.code === 'ABS_FIELD_CONTRACT_UNAVAILABLE');
    expect(providers.get(next.id)).toHaveBeenCalled();
  });

  it('restores exact dormant values, original providers, reason sets and collapse through native save/reopen', () => {
    const state: AbsAbiWorkspace = { blocks: { blocks: [{ type: poisoned, id: 'saved', x: 0, y: 0,
      disabledReasons: ['MANUALLY_DISABLED', 'LIBRARY_REASON'], collapsed: true, fields: { TEXT: 'saved text', MODE: 'retired-choice' } }] } };
    const load = () => { const detached = structuredClone(state); withNativeStateLoading(Blockly, workspace, detached,
      () => Blockly.serialization.workspaces.load(detached, workspace)); };
    for (let round = 0; round < 2; round++) {
      load();
      const owner = workspace.getBlockById('saved')!, provider = providers.get('saved')!;
      expect(owner.getField('MODE')!['getOptions']).toBe(provider);
      expect(provider).not.toHaveBeenCalled();
      assertAbsReadback(state, Blockly.serialization.workspaces.save(workspace) as AbsAbiWorkspace);
      expect(owner.isEnabled()).toBeFalse(); expect(owner.isCollapsed()).toBeTrue();
      const dropdown = owner.getField('MODE') as Blockly.FieldDropdown;
      expect(dropdown.computeAriaLabel()).toContain('retired-choice');
      expect(provider).not.toHaveBeenCalled();
      owner.setDisabledReason(false, 'MANUALLY_DISABLED'); owner.setDisabledReason(false, 'LIBRARY_REASON');
      expect(() => dropdown.getAriaValue()).toThrowError('inactive option provider is unavailable');
      workspace.clear();
    }
  });

  it('keeps the native loader ability to assign omitted IDs before indexing an inactive loading view', () => {
    const state = { blocks: { blocks: [{ type: container, disabledReasons: ['MANUALLY_DISABLED'],
      inputs: { VALUE: { shadow: { type: value, fields: { NUM: 4 } } } } }] } };
    const before = JSON.stringify(state);
    withNativeStateLoading(Blockly, workspace, state, () => Blockly.serialization.workspaces.load(state, workspace));
    expect(workspace.getAllBlocks(false).length).toBe(2);
    expect(new Set(workspace.getAllBlocks(false).map(item => item.id)).size).toBe(2);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('reconciles a new active call with an existing unknown inactive block whose provider is broken', async () => {
    block(); const baseline = await projection();
    const source = splitAbsState(baseline.abs).program + `\n${active}(NUM=7)\n`;
    const prepared = await prepare(baseline, source), blocks = indexAbsAbi(prepared.materialized);
    expect(blocks.get('kept')!.fields).toEqual({ TEXT: 'before', MODE: 'OLD' });
    expect(blocks.get('kept')!['disabledReasons']).toEqual(['MANUALLY_DISABLED', 'LIBRARY_REASON']);
    expect(blocks.get('kept')!['collapsed']).toBeTrue();
    expect(prepared.candidate.added.length).toBe(1);
    expect(prepared.materialized.blocks.blocks.some(item => item.type === active)).toBeTrue();
  });

  for (const scenario of ['edit-inline-child', 'reorder-named-fields'] as const)
  it(`preserves an unchanged protected inactive parent when only ${scenario} needs reconciliation`, async () => {
    const parent = block(inlineParent, 'parent'), child = workspace.newBlock(value, 'child');
    parent.setDeletable(false); parent.getInput('VALUE')!.connection!.connect(child.outputConnection!);
    const baseline = await projection(), program = splitAbsState(baseline.abs).program;
    const source = scenario === 'edit-inline-child' ? program.replace('NUM=1', 'NUM=2')
      : program.replace('MODE=OLD, TEXT="before"', 'TEXT="before", MODE=OLD');
    expect(source).not.toBe(program);
    const prepared = await prepare(baseline, source), blocks = indexAbsAbi(prepared.materialized);
    expect(prepared.candidate.retained).toContain('parent');
    expect(blocks.get('parent')!['deletable']).toBeFalse();
    expect(blocks.get('parent')!['disabledReasons']).toEqual(['MANUALLY_DISABLED', 'LIBRARY_REASON']);
    expect(blocks.get('parent')!.fields).toEqual({ MODE: 'OLD', TEXT: 'before' });
    expect(blocks.get('child')!.fields!['NUM']).toBe(scenario === 'edit-inline-child' ? 2 : 1);
    expect(prepared.instances.has('parent')).toBeFalse();
    if (scenario === 'edit-inline-child') expect(prepared.instances.has('child')).toBeTrue();
  });

  it('does not preserve a poisoned inactive parent whose own selected field changes', async () => {
    const parent = block(inlineParent, 'parent'), child = workspace.newBlock(value, 'child');
    parent.getInput('VALUE')!.connection!.connect(child.outputConnection!);
    const baseline = await projection(), source = splitAbsState(baseline.abs).program.replace('MODE=OLD', 'MODE=NEW');
    await expectAsync(prepare(baseline, source)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_GENERATION_FAILED' }));
  });

  for (const scenario of ['new', 'active', 'changed-fields'] as const) it(`rejects forged inactive preservation for a ${scenario} call`, async () => {
    const owner = block(available);
    if (scenario === 'new') owner.dispose();
    if (scenario === 'active') { owner.setDisabledReason(false, 'MANUALLY_DISABLED'); owner.setDisabledReason(false, 'LIBRARY_REASON'); }
    const baseline = await projection();
    const program = splitAbsState(baseline.abs).program;
    const source = scenario === 'new' ? program + `\n${available}(TEXT="before", MODE=OLD) @disabled\n`
      : scenario === 'changed-fields' ? program.replace('OLD', 'NEW') + '\n# changed\n' : program + '\n# unchanged fields\n';
    const syntax = parseAbsSyntax(source, absSyntaxOptions(baseline.workspace, baseline.contracts));
    const binding: AbsNativeBinding = { source, syntax, instances: [], hostCalls: indexAbsSyntax(syntax).map(({ node }) => ({ start: node.start, type: node.type, preserveInactive: true })) };
    await expectAsync(reconcileAbsDraft(baseline, source, { nativeBinding: binding }))
      .toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_BINDING_INVALID' }));
  });

  it('requires real native evidence for an inactive option edit and never enables the retained block', async () => {
    block(available); const baseline = await projection();
    const source = splitAbsState(baseline.abs).program.replace('OLD', 'NEW');
    await expectAsync(reconcileAbsDraft(baseline, source)).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_RUNTIME_SHAPE_UNSUPPORTED' }));
    const prepared = await prepare(baseline, source), owner = indexAbsAbi(prepared.materialized).get('kept')!;
    expect(owner.fields!['MODE']).toBe('NEW');
    expect(owner['disabledReasons']).toEqual(['MANUALLY_DISABLED', 'LIBRARY_REASON']); expect(owner['collapsed']).toBeTrue();
    expect(prepared.instances.get('kept')!.shape.fields['MODE'].options!.map(option => option[1])).toContain('NEW');
  });

  it('does not register models for a new child under a preserved inactive parent', async () => {
    const parent = workspace.newBlock(container, 'container'); parent.setDisabledReason(true, 'MANUALLY_DISABLED');
    const baseline = await projection();
    const source = splitAbsState(baseline.abs).program + '\n    @DO:\n        test_object_init("ghost", Sensor)\n';
    const prepared = await prepare(baseline, source, [...modelSteps, ...steps]);
    expect(prepared.preparedModels).toEqual([]);
    expect(prepared.materialized['variables'] ?? []).toEqual([]);
    expect(indexAbsAbi(prepared.materialized).get('container')!['disabledReasons']).toEqual(['MANUALLY_DISABLED']);
    expect(indexAbsAbi(prepared.materialized).size).toBe(2);
  });
});
