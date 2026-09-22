import { AbsBlockContextIndex, truncateAbsContext } from './abs-block-context';
import { createAbsProjection } from './abs-identity-map';
import { BlocklyService } from '../../../editors/blockly-editor/services/blockly.service';

describe('canonical selected-block context', () => {
  const projection = () => createAbsProjection({ blocks: { blocks: [{ type: 'text', id: 'selected',
    fields: { TEXT: '中文😀' }, next: { block: { type: 'text', id: 'sibling', fields: { TEXT: 'later' } } } }] } }, {
    document: {}, generation: 'context-generation', baselineRef: 'baseline', scope: { projectKey: 'project', pageId: 'main' },
    savedAbiHash: null, contracts: { fields: { selected: { TEXT: { type: 'field_input' } }, sibling: { TEXT: { type: 'field_input' } } },
      syntax: { selected: [{ kind: 'field', name: 'TEXT' }], sibling: [{ kind: 'field', name: 'TEXT' }] } },
  });

  it('reads exact canonical ranges and does not invent missing block or parent bindings', async () => {
    const value = await projection(), index = new AbsBlockContextIndex(value);
    const binding = value.map.nodes.find(node => node.blockId === 'selected')!;
    expect(index.get('selected')!.snippet).toBe(value.abs.slice(binding.start, binding.end).trimEnd());
    expect(index.get('selected')!.generation).toBe(value.map.generation);
    expect(index.get('missing')).toBeUndefined();
  });

  it('bounds a huge single line as well as long statement bodies', () => {
    expect(truncateAbsContext('x'.repeat(100000)).length).toBeLessThan(2000);
    expect(truncateAbsContext('line\n'.repeat(100))).toContain('lines omitted');
  });

  it('invalidates context on revision, runtime or page change and hides it while leased', async () => {
    const editor = Object.create(BlocklyService.prototype) as any;
    let revision = 1, blocked = false, current = true;
    editor.getProjectPersistenceRevision = () => revision;
    editor.isWorkspaceEditBlocked = () => blocked;
    editor.publishAbsContext(await projection(), revision, () => { if (!current) throw new Error('stale'); });
    expect(editor.readCommittedAbsContext('selected')).toBeDefined();
    const advice = editor.describeCommittedAbsSyntax(['text']);
    expect(advice.scope).toBe('current-workspace'); expect(advice.variants.length).toBe(1);
    expect(JSON.stringify(advice)).not.toMatch(/中文|later|selected|sibling/);
    blocked = true; expect(editor.readCommittedAbsContext('selected')).toBeUndefined();
    expect(editor.describeCommittedAbsSyntax(['text'])).toBeUndefined();
    blocked = false; expect(editor.readCommittedAbsContext('selected')).toBeDefined();
    revision++; expect(editor.readCommittedAbsContext('selected')).toBeUndefined();
    expect(editor.describeCommittedAbsSyntax(['text'])).toBeUndefined();
    editor.publishAbsContext(await projection(), revision, () => { if (!current) throw new Error('stale'); });
    current = false; expect(editor.readCommittedAbsContext('selected')).toBeUndefined();
    expect(editor.describeCommittedAbsSyntax(['text'])).toBeUndefined();
  });
});
