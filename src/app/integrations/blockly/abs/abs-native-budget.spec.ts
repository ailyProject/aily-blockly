import { assertNativeBudget, NATIVE_CANDIDATE_LIMITS } from '../../../editors/blockly-editor/services/blockly-native-budget';
import { assertSynchronousNativeCandidate } from '../../../editors/blockly-editor/services/blockly-native-candidate-policy';
import { restoreAbsFailure, serializeAbsFailure } from './abs-diagnostics';
import { AbsGenerationToolsService } from './abs-generation-tools.service';

describe('native candidate operational budget', () => {
  for (const resource of Object.keys(NATIVE_CANDIDATE_LIMITS) as Array<keyof typeof NATIVE_CANDIDATE_LIMITS>) {
    const limit = NATIVE_CANDIDATE_LIMITS[resource];
    it(`keeps ${resource} inclusive and reports a structured limit instead of a syntax/identity error`, () => {
      expect(() => assertNativeBudget(resource, limit - 1, 'request')).not.toThrow();
      expect(() => assertNativeBudget(resource, limit, 'request')).not.toThrow();
      try { assertNativeBudget(resource, limit + 1, 'request'); fail('over budget'); }
      catch (error) {
        const wire = serializeAbsFailure(restoreAbsFailure(serializeAbsFailure(error)));
        expect(wire.code).toBe('ABS_LIMIT');
        expect(wire.diagnostic!.capacity).toEqual({ resource, phase: 'request', actual: limit + 1, limit });
        expect(wire.diagnostic!.hint).toContain('local Blockly library');
        expect(wire.diagnostic!.hint).toContain('Preserve behavior');
        expect(wire.diagnostic!.truncated).not.toBeTrue();
      }
    });
  }
  for (const [key, item, resource] of [
    ['blocks', {}, 'blocks'], ['identities', {}, 'identities'], ['creations', {}, 'defaultCreations'],
    ['variables', {}, 'variables'], ['hostCalls', {}, 'hostCalls'], ['values', {}, 'resources'],
  ] as const) it(`applies the same bound to request ${key}`, () => {
    try { assertSynchronousNativeCandidate({ steps: [], blocks: [], [key]: Array(NATIVE_CANDIDATE_LIMITS[resource] + 1).fill(item) } as any); fail('over budget'); }
    catch (error) { expect(serializeAbsFailure(error).diagnostic!.capacity!.resource).toBe(resource); }
  });
  it('does not weaken malformed/duplicate identity validation below the limit', () => {
    expect(() => assertSynchronousNativeCandidate({ steps: [], blocks: [], abs: 'text()',
      identities: [{ start: 0, id: 'x' }, { start: 0, id: 'x' }] })).toThrowError(/uniquely/);
  });
  it('guides the agent at the real tool boundary without a success receipt', async () => {
    const limit = NATIVE_CANDIDATE_LIMITS.blocks;
    const sync = { exportGeneration: async () => assertNativeBudget('blocks', limit + 1, 'creation') };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_projection', {
      version: 2, requestId: 'native-budget-diagnostic-request', expectedAbiHash: 'sha256:' + 'a'.repeat(64),
    });
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_LIMIT');
    expect(result.diagnostic.capacity).toEqual({ resource: 'blocks', phase: 'creation', actual: limit + 1, limit });
    expect(result.recovery).toContain('local Blockly library'); expect(result.recovery).toContain('validate and build');
    expect(result.receipt).toBeUndefined();
  });
  it('rejects unbounded/non-numeric capacity data from library errors', () => {
    for (const capacity of [{ phase: 'x', resource: 'x', actual: Infinity, limit: 1 },
      { phase: 'x'.repeat(41), resource: 'x', actual: 2, limit: 1 }, { phase: 'x', resource: 'x', actual: 2, limit: -1 }]) {
      expect(serializeAbsFailure({ diagnostic: { capacity } }).diagnostic).toBeUndefined();
    }
  });
});
