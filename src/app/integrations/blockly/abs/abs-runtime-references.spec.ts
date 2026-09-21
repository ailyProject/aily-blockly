import * as Blockly from 'blockly';
import 'blockly/blocks';
import { captureAbsPageReferenceContract } from './abs-runtime-references';
import { AbsAbiWorkspace } from './abs-state';
import { AbsReferenceContractCache } from './abs-reference-contract-cache';
import { BlocklyProjectDocument, composeBlocklyPage } from '../../../editors/blockly-editor/services/blockly-project-model';
import { absJson } from './abs-identity-map';

describe('actual-instance reference coverage', () => {
  let workspace: Blockly.Workspace;
  const save = (): AbsAbiWorkspace => {
    const state = Blockly.serialization.workspaces.save(workspace);
    return { ...state, blocks: state['blocks'] ?? { blocks: [] } } as AbsAbiWorkspace;
  };
  const capture = () => captureAbsPageReferenceContract(workspace, save(), () => undefined);
  const custom = 'abs_reference_test';
  beforeEach(() => { workspace = new Blockly.Workspace(); });
  afterEach(() => { workspace.dispose(); delete Blockly.Blocks[custom]; });

  it('captures native text and variable references without constructing probe blocks', () => {
    workspace.newBlock('text', 'text');
    workspace.newBlock('variables_get', 'get');
    const probe = spyOn(workspace, 'newBlock').and.callThrough();
    const result = capture();
    expect(result.complete).toBeTrue();
    expect(result.blockTypes).toEqual({ text: 'text', get: 'variables_get' });
    expect(result.contracts.fields['get']['VAR'].symbol?.kind).toBe('variable');
    expect(result.contracts.fields['text']['TEXT'].symbol).toBeUndefined();
    expect(probe).not.toHaveBeenCalled();
  });

  it('verifies legacy parameter models and procedure call signatures from actual instances', () => {
    Blockly.serialization.workspaces.load({ variables: [{ id: 'param', name: 'Count', type: '' }], blocks: { blocks: [
      { type: 'procedures_defnoreturn', id: 'define', fields: { NAME: 'work' }, extraState: { params: [{ id: 'param', name: 'Count' }] } },
      { type: 'procedures_callnoreturn', id: 'call', extraState: { name: 'work', params: ['Count'] } },
    ] } }, workspace);
    const result = capture();
    expect(result.contracts.procedures!['define'].role).toBe('definition');
    expect(result.contracts.procedures!['call'].role).toBe('call');
    expect(result.blockStates!['define']).toContain('param');
  });

  for (const kind of ['extraState', 'data', 'field', 'model', 'getVars']) {
    it(`does not claim complete coverage for unadapted ${kind}`, () => {
      class CustomField extends Blockly.FieldTextInput {}
      Blockly.Blocks[custom] = {
        init() {
          if (kind === 'field') this.appendDummyInput().appendField(new CustomField('value'), 'VALUE');
          if (kind === 'data') this.data = JSON.stringify({ reference: 'hidden' });
        },
        ...(kind === 'extraState' ? { saveExtraState: () => ({ reference: 'hidden' }) } : {}),
        ...(kind === 'model' ? { getProcedureModel: () => ({ id: 'hidden' }) } : {}),
        ...(kind === 'getVars' ? { getVars: () => ['hidden'] } : {}),
      };
      workspace.newBlock(custom);
      expect(capture).toThrow();
    });
  }

  it('rejects references declared by a custom model getter but absent from serialized field/procedure paths', () => {
    const hidden = workspace.createVariable('Hidden', '', 'hidden');
    Blockly.Blocks[custom] = { init() {}, getVarModels: () => [hidden] };
    workspace.newBlock(custom);
    expect(capture).toThrowError(/reference adapter/);
  });
  it('does not trust an empty custom getter whose references can depend on untracked runtime state', () => {
    Blockly.Blocks[custom] = { init() {}, getVarModels: () => [] };
    workspace.newBlock(custom);
    expect(capture).toThrowError(/Custom variable getters/);
  });

  it('refuses serializer-backed models rather than assuming arbitrary JSON contains no references', () => {
    const name = 'abs_reference_test_serializer';
    Blockly.serialization.registry.register(name, { priority: 10, save: () => ({ ref: 'hidden' }), load() {}, clear() {} });
    try { expect(capture).toThrowError(/serializer/); }
    finally { Blockly.serialization.registry.unregister(name); }
  });

  it('does not borrow a live value block contract for its dormant fallback shadow', () => {
    Blockly.serialization.workspaces.load({ blocks: { blocks: [{ type: 'text_print', id: 'print', inputs: {
      TEXT: { block: { type: 'text', id: 'real', fields: { TEXT: 'actual' } },
        shadow: { type: 'text', id: 'shadow', fields: { TEXT: 'fallback' } } },
    } }] } }, workspace);
    expect(capture).toThrowError(/live instance/);
    expect(workspace.getBlockById('real')).toBeTruthy();
    expect(workspace.getBlockById('shadow')).toBeNull();
  });

  it('rejects a stale snapshot, missing live blocks or an incomplete model table', () => {
    const block = workspace.newBlock('text', 'text');
    const old = save(); block.setFieldValue('changed', 'TEXT');
    expect(() => captureAbsPageReferenceContract(workspace, old, () => undefined)).toThrowMatching(error => error.code === 'ABS_REFERENCE_CAPTURE_CHANGED');
    expect(() => captureAbsPageReferenceContract(workspace, { blocks: { blocks: [] } }, () => undefined)).toThrowMatching(error => error.code === 'ABS_REFERENCE_CAPTURE_CHANGED');
    workspace.createVariable('Unused');
    const missing = save(); delete missing['variables'];
    expect(() => captureAbsPageReferenceContract(workspace, missing, () => undefined)).toThrowMatching(error => error.code === 'ABS_REFERENCE_CAPTURE_CHANGED');
  });

  it('verifies the workspace even when a library option provider mutates and then throws', () => {
    Blockly.Blocks[custom] = { init() { this.appendDummyInput().appendField(new Blockly.FieldDropdown([['A', 'a']]), 'MODE'); } };
    const block = workspace.newBlock(custom);
    spyOn(block.getField('MODE') as Blockly.FieldDropdown, 'getOptions').and.callFake(() => {
      block.data = 'mutation'; throw new Error('provider failed');
    });
    expect(capture).toThrowMatching(error => error.code === 'ABS_REFERENCE_CAPTURE_CHANGED');
  });

  it('stops when the runtime changes during a getter', () => {
    Blockly.Blocks[custom] = { init() { this.appendDummyInput().appendField(new Blockly.FieldDropdown([['A', 'a']]), 'MODE'); } };
    const block = workspace.newBlock(custom);
    let current = true;
    spyOn(block.getField('MODE') as Blockly.FieldDropdown, 'getOptions').and.callFake(() => { current = false; return [['A', 'a']]; });
    expect(() => captureAbsPageReferenceContract(workspace, save(), () => { if (!current) throw new Error('stale'); })).toThrowError('stale');
  });
});

describe('page reference evidence lifetime', () => {
  const document = (): BlocklyProjectDocument => ({ schemaVersion: 3, activePageId: 'one', openedPageIds: ['one'],
    sharedModel: { procedureBlocks: [], variables: [{ id: 'v', name: 'Name', type: '' }] },
    pages: [{ id: 'one', title: 'One', content: { blocks: { blocks: [{ type: 'text', id: 't', fields: { TEXT: 'same' } }] } } }],
  });
  const contract = () => ({ complete: true as const, blockTypes: { t: 'text' }, serializers: [], contracts: { fields: { t: { TEXT: { type: 'field_input' } } } } });
  it('binds exact block/shared-model content but not page titles or tabs', () => {
    const cache = new AbsReferenceContractCache(); const source = document();
    cache.remember(source, 'one', contract());
    source.pages[0].title = 'renamed'; source.openedPageIds = [];
    expect(cache.matching(source)['one']).toEqual(contract());
    source.pages[0].content.blocks.blocks[0].fields.TEXT = 'edited';
    expect(cache.matching(source)['one']).toBeUndefined();
    source.pages[0].content.blocks.blocks[0].fields.TEXT = 'same';
    source.sharedModel.variables![0].name = 'renamed model';
    expect(cache.matching(source)['one']).toBeUndefined();
  });
  it('drops evidence when workspace/generator/data session changes, without reviving an older session', () => {
    const cache = new AbsReferenceContractCache(); const workspace = {}; const generator = {};
    cache.setScope(workspace, generator, 'data'); cache.remember(document(), 'one', contract());
    cache.setScope(workspace, generator, 'data'); expect(cache.matching(document())['one']).toBeDefined();
    cache.setScope(workspace, {}, 'data'); expect(cache.matching(document())['one']).toBeUndefined();
    cache.setScope(workspace, generator, 'data'); expect(cache.matching(document())['one']).toBeUndefined();
    cache.remember(document(), 'one', contract()); cache.setScope(workspace, generator, 'other-data');
    expect(cache.matching(document())['one']).toBeUndefined();
  });
  it('retains immutable evidence and returns detached contracts', () => {
    const cache = new AbsReferenceContractCache(); const captured = contract();
    cache.remember(document(), 'one', captured); captured.contracts.fields.t.TEXT.type = 'wrong';
    const result = cache.matching(document()); result['one'].contracts.fields['t']['TEXT'].type = 'also wrong';
    expect(cache.matching(document())['one'].contracts.fields['t']['TEXT'].type).toBe('field_input');
  });
  it('bounds retained evidence and forgets removed pages rather than retaining arbitrary large values', () => {
    const cache = new AbsReferenceContractCache(1);
    cache.remember(document(), 'one', contract()); expect(cache.matching(document())['one']).toBeUndefined();
    const normal = new AbsReferenceContractCache(); normal.remember(document(), 'one', contract());
    const removed = document(); removed.pages = []; expect(normal.matching(removed)).toEqual({});
    expect(normal.matching(document())['one']).toBeUndefined();
  });
  it('rejects unbounded/invalid limits and evicts oldest evidence when the budget is exhausted', () => {
    for (const limit of [NaN, Infinity, -1, 0.5]) expect(() => new AbsReferenceContractCache(limit)).toThrow();
    const source = document(); source.pages.push({ ...source.pages[0], id: 'two' });
    const limit = absJson(composeBlocklyPage(source, 'one')).length + absJson(contract()).length;
    const cache = new AbsReferenceContractCache(limit);
    cache.remember(source, 'one', contract()); expect(cache.matching(source)['one']).toBeDefined();
    cache.remember(source, 'two', contract());
    expect(cache.matching(source)['one']).toBeUndefined();
    expect(cache.matching(source)['two']).toBeDefined();
  });
});
