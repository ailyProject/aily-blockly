import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { AbsApplicationFailure } from './abs-application-failure';
import { AbsSyncError } from './abs-state';
import { readAbsBlockStateRequest } from './abs-block-state';

describe('existing block state wire outcomes', () => {
  const request = { version: 2, requestId: 'state-request-000001', action: 'inspect' };
  it('preserves over-limit UTF-16 ID capacity and non-commit facts through real state admission and wire serialization', async () => {
    const input = { version: 2, requestId: request.requestId, action: 'update', expectedCanvas: 'inspected-canvas',
      changes: [{ blockId: '😀'.repeat(256) + 'x', disabled: true }] };
    const service = new AbsGenerationToolsService({ setBlockState: readAbsBlockStateRequest } as any);
    const actual = await service.blockState(input);
    expect(actual).toEqual(jasmine.objectContaining({ ok: false, operation: 'blocks_set_state',
      code: 'ABS_BLOCK_STATE_ID_LIMIT', publication: { status: 'NOT_COMMITTED' },
      diagnostic: jasmine.objectContaining({ reason: 'block-id-length', capacity: {
        phase: 'block-state-admission', resource: 'blockIdCodeUnits', actual: 513, limit: 512,
      } }),
    }));
    expect((actual as any).message).toContain('513 exceeds 512 UTF-16 code units after JSON decoding');
    expect((actual as any).diagnostic.hint).toContain('do not rename/truncate IDs or edit ABI/map');
  });
  it('preserves a read-only inspection result and its request receipt', async () => {
    const result = { ok: true, project: 'project', expectedGeneration: 'g1', requiresReload: false,
      instances: [], totalMatches: 0, offset: 0, limit: 50, truncated: false, receipt: request };
    const sync = { setBlockState: jasmine.createSpy('state').and.resolveTo(result) };
    const actual = await new AbsGenerationToolsService(sync as any).blockState(request);
    expect(actual).toEqual({ ...result, operation: 'blocks_set_state' });
    expect(sync.setBlockState).toHaveBeenCalledOnceWith(request);
  });
  it('does not discard committed mirror evidence merely because derived output is partial', async () => {
    const result = { ok: false, projectSaved: true, generatedCodePublished: false, partial: true,
      publication: { status: 'COMMITTED', generation: 'g2' }, abs: 'complete ABS', states: [],
      receipt: { version: 2, requestId: request.requestId, action: 'update', beforeStates: [], states: [], output: { binding: { generation: 'g2' } } } };
    const actual = await new AbsGenerationToolsService({ setBlockState: async () => result } as any).blockState(request);
    expect(actual).toEqual({ ...result, operation: 'blocks_set_state' });
  });
  it('keeps explicit precommit rollback facts instead of reporting an unknown write', async () => {
    const failure = new AbsApplicationFailure(new AbsSyncError('ABS_TEST_FAILURE', 'failed before commit'), 'ROLLED_BACK');
    const actual = await new AbsGenerationToolsService({ setBlockState: async () => { throw failure; } } as any).blockState(request);
    expect(actual).toEqual(jasmine.objectContaining({ ok: false, publication: { status: 'NOT_COMMITTED' }, application: { status: 'ROLLED_BACK' } }));
  });
  it('preserves uncertain publication and partial-save facts without guessing rollback', async () => {
    const failure = Object.assign(new Error('acknowledgement lost'), { code: 'ABS_COMMIT_UNKNOWN',
      publication: { status: 'UNKNOWN' }, application: { status: 'UNKNOWN' },
      projectSaved: true, generatedCodePublished: false, partial: true });
    const actual = await new AbsGenerationToolsService({ setBlockState: async () => { throw failure; } } as any).blockState(request);
    expect(actual).toEqual(jasmine.objectContaining({ ok: false, publication: { status: 'UNKNOWN' }, application: { status: 'UNKNOWN' },
      projectSaved: true, generatedCodePublished: false, partial: true }));
  });
});
