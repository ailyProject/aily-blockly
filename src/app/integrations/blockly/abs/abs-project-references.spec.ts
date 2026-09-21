import { assertAbsProjectSharedChange, AbsPageReferenceContract } from './abs-project-references';
import { BlocklyProjectDocument } from '../../../editors/blockly-editor/services/blockly-project-model';

describe('cross-page shared reference contracts', () => {
  const document = (): BlocklyProjectDocument => ({ schemaVersion: 3, activePageId: 'one', openedPageIds: ['one', 'two'],
    sharedModel: { variables: [{ id: 'v', name: 'value', type: 'Number' }, { id: 'unused', name: 'unused', type: '' }],
      procedureBlocks: [{ id: 'd', type: 'define', fields: { TITLE: 'run' }, extraState: { args: [] } }] },
    pages: [{ id: 'one', title: 'One', content: { blocks: { blocks: [] } } },
      { id: 'two', title: 'Two', content: { blocks: { blocks: [
        { id: 'get', type: 'reference', fields: { VALUE: { id: 'v' }, PAYLOAD: { id: 'ordinary-data' } } },
        { id: 'c', type: 'invoke', extraState: { target: 'run', args: [] } },
      ] } } }],
  });
  const coverage = (): Record<string, AbsPageReferenceContract> => ({ two: { complete: true,
    blockTypes: { d: 'define', get: 'reference', c: 'invoke' }, serializers: [], contracts: {
      fields: { d: { TITLE: { type: 'field_input' } }, get: {
        VALUE: { type: 'field_variable', symbol: { kind: 'variable', storage: 'variable-state', allowedTypes: ['Number'] } },
        PAYLOAD: { type: 'custom-json' },
      }, c: {} },
      procedures: {
        d: { role: 'definition', namePath: '/fields/TITLE', parametersPath: '/extraState/args', parameterNamePath: '', returns: false },
        c: { role: 'call', namePath: '/extraState/target', parametersPath: '/extraState/args', parameterNamePath: '', returns: false },
      },
    },
  } });
  it('does not demand contracts when shared state is unchanged', () => {
    expect(() => assertAbsProjectSharedChange(document(), document(), 'one')).not.toThrow();
  });
  it('treats absent and empty native variable tables as equivalent', () => {
    const before = document(); before.sharedModel.variables = [];
    const after = document(); delete after.sharedModel.variables;
    expect(() => assertAbsProjectSharedChange(before, after, 'one')).not.toThrow();
  });
  it('does not treat native variable-table reordering as a shared model edit', () => {
    const after = document(); after.sharedModel.variables!.reverse();
    delete after.sharedModel.variables![0].type;
    expect(() => assertAbsProjectSharedChange(document(), after, 'one')).not.toThrow();
  });
  it('fails closed on a shared change without reference coverage for another populated page', () => {
    const after = document(); after.sharedModel.variables!.pop();
    expect(() => assertAbsProjectSharedChange(document(), after, 'one')).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
  });
  it('permits removing an unused model with complete contracts and preserves ordinary JSON identities', () => {
    const after = document(); after.sharedModel.variables!.pop();
    expect(() => assertAbsProjectSharedChange(document(), after, 'one', coverage())).not.toThrow();
  });
  it('permits additive models only with verified unchanged references on populated pages', () => {
    const before = document(), after = document();
    after.sharedModel.variables!.push({ id: 'prepared', name: 'counter', type: '' });
    expect(() => assertAbsProjectSharedChange(before, after, 'one', coverage())).not.toThrow();
    expect(() => assertAbsProjectSharedChange(before, after, 'one')).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
    const opaque = document(); opaque.pages[1].content['customModel'] = { ref: 'v' };
    const changed = JSON.parse(JSON.stringify(opaque)); changed.sharedModel.variables.push({ id: 'prepared', name: 'counter', type: '' });
    expect(() => assertAbsProjectSharedChange(opaque, changed, 'one', coverage())).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
  });
  it('rejects deleting or changing the type of a variable used by an unchanged page', () => {
    const after = document(); after.sharedModel.variables!.shift();
    expect(() => assertAbsProjectSharedChange(document(), after, 'one', coverage())).toThrowMatching(error => error.code === 'ABS_SYMBOL_MISSING');
    const changed = document(); changed.sharedModel.variables![0].type = 'String';
    expect(() => assertAbsProjectSharedChange(document(), changed, 'one', coverage())).toThrow();
  });
  it('rejects removing, renaming or changing the signature of a referenced shared procedure', () => {
    for (const edit of [
      (d: BlocklyProjectDocument) => { d.sharedModel.procedureBlocks = []; },
      (d: BlocklyProjectDocument) => { d.sharedModel.procedureBlocks[0].fields.TITLE = 'renamed'; },
      (d: BlocklyProjectDocument) => { d.sharedModel.procedureBlocks[0].extraState.args = ['new-argument']; },
    ]) {
      const after = document(); edit(after);
      expect(() => assertAbsProjectSharedChange(document(), after, 'one', coverage())).toThrowMatching(error => error.code === 'ABS_PROCEDURE_INVALID');
    }
  });
  it('rejects retargeting a name-based call to a replacement definition with a different identity', () => {
    const after = document(); after.sharedModel.procedureBlocks[0].id = 'replacement';
    const contracts = coverage();
    contracts['two'].blockTypes = { ...contracts['two'].blockTypes, replacement: 'define' };
    contracts['two'].contracts.fields['replacement'] = contracts['two'].contracts.fields['d'];
    contracts['two'].contracts.procedures!['replacement'] = contracts['two'].contracts.procedures!['d'];
    expect(() => assertAbsProjectSharedChange(document(), after, 'one', contracts)).toThrowMatching(error => error.code === 'ABS_SHARED_REFERENCE_CHANGED');
  });
  it('checks fallback shadows instead of scanning only visible top-level blocks', () => {
    const before = document();
    before.pages[1].content.blocks.blocks[0] = { id: 'parent', type: 'parent', inputs: { VALUE: {
      shadow: { id: 'get', type: 'reference', fields: { VALUE: { id: 'v' } } },
    } } };
    const after = JSON.parse(JSON.stringify(before)); after.sharedModel.variables.shift();
    const contracts = coverage(); contracts['two'].blockTypes = { ...contracts['two'].blockTypes, parent: 'parent' };
    expect(() => assertAbsProjectSharedChange(before, after, 'one', contracts)).toThrowMatching(error => error.code === 'ABS_SYMBOL_MISSING');
  });
  it('does not treat an empty block list as an empty page when a custom serializer is present', () => {
    const before = document(); before.pages[1].content = { blocks: { blocks: [] }, customModel: { ref: 'v' } };
    const after = JSON.parse(JSON.stringify(before)); after.sharedModel.variables.pop();
    expect(() => assertAbsProjectSharedChange(before, after, 'one')).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
    expect(() => assertAbsProjectSharedChange(before, after, 'one', coverage())).toThrowMatching(error => error.code === 'ABS_SHARED_CONTRACT_REQUIRED');
  });
  it('rejects contract holes or changed block types rather than assuming unknown fields are not references', () => {
    const after = document(); after.sharedModel.variables!.pop();
    const hole = coverage(); delete hole['two'].contracts.fields['get']['VALUE'];
    expect(() => assertAbsProjectSharedChange(document(), after, 'one', hole)).toThrow();
    const stale = coverage(); stale['two'].blockTypes = { ...stale['two'].blockTypes, get: 'different' };
    expect(() => assertAbsProjectSharedChange(document(), after, 'one', stale)).toThrow();
  });
});
