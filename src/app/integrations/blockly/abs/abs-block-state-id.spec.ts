import * as Blockly from 'blockly';
import { assertBlocklyDocumentIdentities } from '../../../editors/blockly-editor/services/blockly-project-model';
import { inspectLiveBlockStates } from '../../../editors/blockly-editor/services/blockly-block-state-operation';
import { ABS_BLOCK_STATE_ID_MAX_LENGTH, planAbsBlockStateChanges, readAbsBlockStateRequest } from './abs-block-state';
import type { AbsBlockStateUpdateRequest } from './abs-block-state';

describe('block state exact ID length contract', () => {
  const update = (id: string): AbsBlockStateUpdateRequest => ({ version: 2, requestId: 'state-id-request-0001',
    action: 'update', expectedCanvas: 'inspected-canvas', changes: [{ blockId: id, collapsed: true }] });
  const inspect = (id: string) => ({ version: 2, requestId: 'state-id-request-0001', action: 'inspect', blockIds: [id] });
  for (const id of [256, 257, 300, 512].map(length => 'x'.repeat(length)).concat([
    '中'.repeat(512), '😀'.repeat(256), '😀'.repeat(255) + 'xy',
  ])) it('accepts exact native ID of ' + id.length + ' UTF-16 units / ' + new TextEncoder().encode(id).length + ' UTF-8 bytes', () => {
    expect(readAbsBlockStateRequest(update(id))).toEqual(update(id));
    expect(readAbsBlockStateRequest(inspect(id))).toEqual(inspect(id) as any);
    Blockly.Blocks['state_long_id_fixture'] = { init() {} };
    const workspace = new Blockly.Workspace();
    try {
      workspace.newBlock('state_long_id_fixture', id);
      const state = Blockly.serialization.workspaces.save(workspace) as any;
      const document = { schemaVersion: 3, activePageId: 'main', openedPageIds: ['main'],
        pages: [{ id: 'main', title: 'Main', content: state }], sharedModel: { procedureBlocks: [] } };
      assertBlocklyDocumentIdentities(document as any);
      const found = inspectLiveBlockStates(workspace, { version: 2, requestId: 'state-id-request-0001',
        action: 'inspect', blockTypes: ['state_long_id_fixture'] });
      expect(found.instances[0].blockId).toBe(id);
      const plan = planAbsBlockStateChanges(state, update(found.instances[0].blockId));
      expect(plan.states[0].blockId).toBe(id); expect(plan.states[0].collapsed).toBeTrue();
      expect(workspace.getBlockById(id)!.isCollapsed()).toBeFalse();
    } finally { workspace.dispose(); delete Blockly.Blocks['state_long_id_fixture']; }
  });

  for (const id of ['x'.repeat(513), '😀'.repeat(256) + 'x', '😀'.repeat(257)]) {
    for (const request of [update(id), inspect(id)]) it('rejects over-limit ID atomically with actionable exact-unit diagnostics: ' + id.length, () => {
      try { readAbsBlockStateRequest(request); fail('must reject'); }
      catch (error) {
        expect(error.code).toBe('ABS_BLOCK_STATE_ID_LIMIT');
        expect(error.publication.status).toBe('NOT_COMMITTED');
        expect(error.diagnostic.capacity).toEqual({ phase: 'block-state-admission', resource: 'blockIdCodeUnits',
          actual: id.length, limit: ABS_BLOCK_STATE_ID_MAX_LENGTH });
        expect(error.message).toContain('UTF-16 code units after JSON decoding');
        expect(error.diagnostic.hint).toContain('do not rename/truncate IDs or edit ABI/map');
      }
    });
  }

  it('rejects an entire mixed update without changing any candidate or silently shortening an ID', () => {
    const workspace = { blocks: { blocks: [{ id: 'normal', type: 'state_long_id_fixture' },
      { id: 'x'.repeat(513), type: 'state_long_id_fixture' }] } }, before = JSON.stringify(workspace);
    const input = update('x'.repeat(513)); input.changes.unshift({ blockId: 'normal', disabled: true });
    expect(() => planAbsBlockStateChanges(workspace, input)).toThrowError(/513 exceeds 512/);
    expect(JSON.stringify(workspace)).toBe(before);
  });

  it('keeps the narrower type, page, filter, authority, duplicate-ID and control-character bounds', () => {
    const id = 'x'.repeat(512), valid = update(id);
    for (const invalid of [
      { ...inspect(id), blockTypes: ['t'.repeat(257)] },
      { ...inspect(id), blockTypes: Array.from({ length: 17 }, (_, index) => 't' + index) },
      { ...inspect(id), blockIds: Array.from({ length: 257 }, (_, index) => 'b' + index) },
      { ...inspect(id), limit: 257 }, { ...inspect(id), offset: 100001 },
      { ...valid, expectedCanvas: 'c'.repeat(97) }, { ...valid, expectedGeneration: 'g' },
      { ...valid, changes: [valid.changes[0], valid.changes[0]] }, update('x\u0000y'),
      { ...valid, changes: [{ blockId: id, editable: true }] },
    ]) expect(() => readAbsBlockStateRequest(invalid)).toThrow();
  });
});
