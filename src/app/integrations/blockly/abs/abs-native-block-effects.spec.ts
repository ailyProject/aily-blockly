import * as Blockly from 'blockly';
import 'blockly/blocks';
import { evaluateNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate';
import { retireNativeInputDefault, withNativeBlockCreation } from '../../../editors/blockly-editor/services/blockly-native-block-effects';
import { withNativeStateLoading } from '../../../editors/blockly-editor/services/blockly-native-state-loading';
import { nativeDefaultSource, nativeDefaultSteps } from './abs-native-defaults.fixture';
import type { NativeCandidateRequest } from '../../../editors/blockly-editor/services/blockly-native-candidate-protocol';
import { absJson } from './abs-json';
import { createAbsProjection } from './abs-identity-map';
import { prepareAbsNativeReconciliation } from './abs-native-reconciliation';

describe('native temporary child ownership', () => {
  let workspace: Blockly.Workspace;
  beforeEach(() => {
    workspace = new Blockly.Workspace();
    new Function('Blockly', 'Arduino', nativeDefaultSource)(Blockly, { forBlock: {} });
  });
  afterEach(() => {
    workspace.dispose(); delete Blockly.Blocks['native_default_owner']; delete Blockly.Blocks['native_default_leaf'];
    expect(document.querySelectorAll('[data-blockly-native-candidate]').length).toBe(0);
  });
  const input = (fields: any = { MODE: 'B' }) => ({ blocks: { blocks: [{ type: 'native_default_owner', id: 'owner',
    fields, extraState: { enabled: true }, inputs: { VALUE: { block: { type: 'math_number', id: 'saved', fields: { NUM: 7 } } } },
  }] } });
  const load = (state: unknown) => withNativeStateLoading(Blockly, workspace, state, () => Blockly.serialization.workspaces.load(state, workspace));
  const request = (source: string, script = ''): NativeCandidateRequest => ({ blocks: [], abs: '# ABS Schema: 2\n' + source,
    steps: [...nativeDefaultSteps, ...(script ? [{ kind: 'script' as const, label: 'effect', source: script }] : [])],
  });
  const run = (value: NativeCandidateRequest) => evaluateNativeCandidate(value, { assertCurrent() {} });

  it('records nested init under one owner and restores a preexisting method even on failure', () => {
    const original = workspace.newBlock.bind(workspace);
    Object.defineProperty(workspace, 'newBlock', { value: original, configurable: true, writable: true, enumerable: true });
    const descriptor = Object.getOwnPropertyDescriptor(workspace, 'newBlock');
    const origins: string[] = [];
    expect(() => withNativeBlockCreation(workspace, () => {
      workspace.newBlock('native_default_owner', 'owner'); throw Error('stop');
    }, (_block, _id, owner) => origins.push(owner!))).toThrowError('stop');
    expect(origins).toEqual(['owner', 'owner', 'owner']);
    expect(Object.getOwnPropertyDescriptor(workspace, 'newBlock')).toEqual(descriptor);
  });

  it('does not dispose any part of a subtree containing an existing unowned child', () => {
    const owner = workspace.newBlock('native_default_owner', 'owner');
    const root = owner.getInputTargetBlock('VALUE')!, child = root.getInputTargetBlock('CHILD')!;
    expect(() => retireNativeInputDefault(owner.getInput('VALUE')!.connection!, block => block === root)).toThrowError(/unowned/);
    expect(root.isDisposed()).toBeFalse(); expect(child.isDisposed()).toBeFalse();
    expect(owner.getInputTargetBlock('VALUE')).toBe(root);
  });

  it('replays exact ABI children after init, extraState and field defaults without orphan blocks', () => {
    const state = input(), before = absJson(state), original = workspace.newBlock;
    for (let i = 0; i < 2; i++) {
      load(state);
      expect(workspace.getAllBlocks(false).length).toBe(2);
      expect(workspace.getBlockById('owner')!.getInputTargetBlock('VALUE')!.id).toBe('saved');
      expect(workspace.getBlockById('saved')!.getFieldValue('NUM')).toBe(7);
    }
    expect(absJson(state)).toBe(before); expect(workspace.newBlock).toBe(original);
    expect(Object.getOwnPropertyDescriptor(state.blocks.blocks[0], 'inputs')!.get).toBeUndefined();
  });

  it('treats absent ABI inputs as empty topology and supports fieldless ID-less states', () => {
    const state: any = { blocks: { blocks: [{ type: 'native_default_owner' }] } };
    load(state);
    expect(workspace.getAllBlocks(false).length).toBe(1);
    expect(workspace.getAllBlocks(false)[0].getInputTargetBlock('VALUE')).toBeNull();
    expect(state.blocks.blocks[0].id).toBeUndefined();
    expect(Object.getOwnPropertyDescriptor(state.blocks.blocks[0], 'inputs')).toBeUndefined();
  });

  it('replays persisted fallback shadow IDs instead of adopting an init default', () => {
    const state: any = input(); state.blocks.blocks[0].inputs.VALUE.shadow = { type: 'math_number', id: 'fallback', fields: { NUM: 11 } };
    load(state);
    expect(workspace.getAllBlocks(false).length).toBe(2);
    workspace.getBlockById('saved')!.dispose(false);
    const shadow = workspace.getBlockById('owner')!.getInputTargetBlock('VALUE')!;
    expect(shadow.id).toBe('fallback'); expect(shadow.isShadow()).toBeTrue(); expect(shadow.getFieldValue('NUM')).toBe(11);
  });

  it('rejects an init callback moving a previously loaded requested block into its default tree', () => {
    const original = Blockly.Blocks['native_default_owner'].makeDefault;
    Blockly.Blocks['native_default_owner'].makeDefault = function() {
      original.call(this);
      const leaf = this.getInputTargetBlock('VALUE');
      leaf.getInputTargetBlock('CHILD').dispose();
      leaf.getInput('CHILD').connection.connect(this.workspace.getBlockById('existing').outputConnection);
    };
    expect(() => load({ blocks: { blocks: [{ type: 'math_number', id: 'existing', fields: { NUM: 9 } },
      { type: 'native_default_owner', id: 'owner', fields: { MODE: 'A' } }] } })).toThrowError(/unowned or requested/);
    expect(workspace.getBlockById('existing')!.isDisposed()).toBeFalse();
    expect(Object.hasOwn(workspace, 'newBlock')).toBeFalse();
  });

  for (const child of ['math_number(7)', 'null']) it(`binds explicit ${child} over temporary real defaults without adopting them`, async () => {
    const result = await run(request(`native_default_owner(B, ${child})`));
    const root = result.state['blocks'].blocks[0];
    expect(result.state['blocks'].blocks.length).toBe(1);
    expect(root.inputs?.VALUE?.block?.fields.NUM ?? null).toBe(child === 'null' ? null : 7);
    expect(result.binding!.instances.length).toBe(child === 'null' ? 1 : 2);
    expect(absJson(result.state)).not.toContain('native_default_leaf');
  });

  it('captures omitted default trees with stable IDs before callbacks run, then replays them', async () => {
    const value = request('native_default_owner(B)', `
      const init = Blockly.Blocks.native_default_leaf.init;
      Blockly.Blocks.native_default_leaf.init = function() { init.call(this); this.data = 'self:' + this.id; };
    `);
    const first = (await run(value)).binding!;
    expect(first.defaults!.length).toBe(1);
    expect(first.defaults![0].instances.length).toBe(2);
    const leaf = first.defaults![0].state.block!;
    expect(leaf['data']).toBe('self:' + leaf.id);
    const second = (await run({ ...value, identities: first.instances.map(item => ({ start: item.start, id: 'final-owner' })),
      creations: first.creations })).binding!;
    expect(second.defaults).toEqual(first.defaults);
    expect(second.creations).toEqual(first.creations);
    expect(second.instances[0].id).toBe('final-owner');
  });

  it('captures a visible shadow through connection ownership without turning it into a real block', async () => {
    const result = await run(request('native_default_owner(A)', `
      Blockly.Blocks.native_default_owner.makeDefault = function() {
        this.getInput('VALUE').connection.setShadowState({ type: 'math_number', fields: { NUM: 13 } });
      };
    `));
    const effect = result.binding!.defaults![0];
    expect(effect.state.block).toBeUndefined(); expect(effect.state.shadow!.fields!['NUM']).toBe(13);
    expect(effect.instances[0].id).toBe(effect.state.shadow!.id);
  });

  it('rejects a changed or incomplete creation journal, and a default root outside an input', async () => {
    const value = request('native_default_owner(A)'), first = (await run(value)).binding!;
    const identities = first.instances.map(item => ({ start: item.start, id: 'final-owner' }));
    await expectAsync(run({ ...value, identities, creations: [] })).toBeRejectedWithError(/creation changed/);
    await expectAsync(run({ ...value, identities, creations: first.creations!.map(item => ({ ...item, type: 'other' })) })).toBeRejectedWithError(/creation changed/);
    await expectAsync(run(request('native_default_owner(A)', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this); this.workspace.newBlock('math_number'); };
    `))).toBeRejectedWithError(/unrequested blocks/);
  });

  it('does not interpret explicit null as permission to delete a native shadow default', async () => {
    await expectAsync(run(request('native_default_owner(A, null)', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this); this.getInputTargetBlock('VALUE').setShadow(true); };
    `))).toBeRejectedWithError(/default shadow/);
  });

  it('retains evidence for a native shadow underneath an explicit real child', async () => {
    const value = request('native_default_owner(A, math_number(7))', `
      Blockly.Blocks.native_default_owner.makeDefault = function() {
        this.getInput('VALUE').connection.setShadowState({ type: 'math_number', fields: { NUM: 13 } });
      };
    `);
    const first = (await run(value)).binding!;
    expect(first.defaults![0].fallback).toBeTrue();
    expect(first.defaults![0].state.shadow!.fields!['NUM']).toBe(13);
    const second = (await run({ ...value, identities: first.instances.map(item => ({ start: item.start, id: 'final-' + item.start })),
      creations: first.creations })).binding!;
    expect(second.defaults).toEqual(first.defaults);
  });

  it('rejects owner-ID-dependent default content before resource preparation or host loading', async () => {
    const value = request('native_default_owner(A)', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this); this.getInputTargetBlock('VALUE').data = this.id; };
    `);
    const workspace = { blocks: { blocks: [] } };
    const baseline = await createAbsProjection(workspace, { document: workspace, contracts: { fields: {} },
      generation: 'g', baselineRef: 'b', savedAbiHash: null, scope: { projectKey: 'p', pageId: 'main' } });
    const calls: NativeCandidateRequest[] = [];
    await expectAsync(prepareAbsNativeReconciliation(baseline, value.abs!, {}, async input => {
      const next = { ...value, ...input }; calls.push(next); return run(next);
    }, () => {})).toBeRejectedWith(jasmine.objectContaining({ code: 'ABS_NATIVE_BINDING_CHANGED' }));
    expect(calls.length).toBe(2); expect(calls.some(call => !!call.verify)).toBeFalse();
  });

  for (const effect of [
    `this.workspace.newBlock('math_number');`,
    `this.workspace.createVariable('leaked-model');`,
    `try { setTimeout(() => { this.workspace.createVariable('deferred-leaked-model'); }, 1); } catch {}`,
  ]) it(`still rejects unrelated effects from a discarded default: ${effect}`, async () => {
    await expectAsync(run(request('native_default_owner(A, math_number(7))', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this); ${effect} };
    `))).toBeRejected();
  });

  it('rejects model effects during disposal instead of deleting the model to hide them', async () => {
    await expectAsync(run(request('native_default_owner(A, math_number(7))', `
      const init = Blockly.Blocks.native_default_leaf.init;
      Blockly.Blocks.native_default_leaf.init = function() { init.call(this);
        const dispose = this.dispose;
        this.dispose = function(...args) { const ws = this.workspace; dispose.apply(this, args); ws.createVariable('disposal-model'); };
      };
    `))).toBeRejectedWithError(/variable ownership/);
  });

  it('allows reusing an explicit model while retiring a default, retaining its identity', async () => {
    const value = request('native_default_owner(A, math_number(7))', `
      const make = Blockly.Blocks.native_default_owner.makeDefault;
      Blockly.Blocks.native_default_owner.makeDefault = function() { make.call(this); this.workspace.createVariable('counter'); };
    `);
    value.variables = [{ id: 'counter-id', name: 'counter' }];
    expect((await run(value)).state['variables']).toEqual([{ id: 'counter-id', name: 'counter' }]);
  });
});
