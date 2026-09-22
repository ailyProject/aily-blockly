import { restoreAbsFailure, serializeAbsFailure } from './abs-diagnostics';
import { AbsSyncError } from './abs-state';
import { AbsSymbols } from './abs-symbols';
import { resolveAbsFieldValue, readAbsFieldToken } from './abs-field-values';
import { AbsGenerationToolsService } from './abs-generation-tools.service';
import { createAbsProjection } from './abs-identity-map';
import { reconcileAbs } from './abs-reconciler';
import { assertAbsProtectedBlocks } from './abs-import-policy';
import { parseAbsSyntax } from './abs-syntax';

describe('ABS actionable diagnostic contract', () => {
  it('sanitizes runtime resource evidence without losing build hashes or status', () => {
    const wire = serializeAbsFailure({ diagnostic: { resource: {
      url: 'https://user:secret@localhost:4200/blockly/runtime/native-candidate.js?token=secret#secret',
      status: 404, expectedHash: 'a'.repeat(64), actualHash: 'b'.repeat(64), body: 'private response',
    } } });
    expect(wire.diagnostic!.resource).toEqual({ url: 'https://localhost:4200/blockly/runtime/native-candidate.js',
      status: 404, expectedHash: 'a'.repeat(64), actualHash: 'b'.repeat(64) });
    expect(JSON.stringify(wire)).not.toMatch(/secret|private response/);
    for (const url of ['javascript:alert(1)', 'broken', 'https://' + 'a'.repeat(2050)]) {
      expect(serializeAbsFailure({ diagnostic: { resource: { url } } }).diagnostic).toBeUndefined();
    }
    expect(serializeAbsFailure({ diagnostic: { resource: { url: 'http://localhost/', status: -1,
      expectedHash: 'invalid', actualHash: {} } } }).diagnostic!.resource).toEqual({ url: 'http://localhost/' });
  });

  it('preserves resource failure evidence through the tool boundary without a success receipt', async () => {
    const resource = { url: 'http://localhost/blockly/runtime/native-candidate.js', status: 404, expectedHash: 'a'.repeat(64) };
    const sync = { exportGeneration: async () => { throw new AbsSyncError('ABS_NATIVE_ASSET_UNAVAILABLE',
      'Cannot load runtime', undefined, [], { reason: 'http-status', resource, hint: 'Repair the host asset service; retain ABS.' }); } };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_projection', {
      version: 2, requestId: 'native-asset-diagnostic-request', expectedAbiHash: 'sha256:' + 'a'.repeat(64),
    });
    expect(result.ok).toBeFalse(); expect(result.receipt).toBeUndefined();
    expect(result.diagnostic.resource).toEqual(resource);
    expect(result.recovery).toBe('Repair the host asset service; retain ABS.');
  });

  it('explains duplicate positional/section assignments without guessing or dropping either value', () => {
    try {
      parseAbsSyntax('# ABS Schema: 2\narbitrary_branch(math_number(0))\n    @COND: math_number(1)', {
        argumentOrder: type => type === 'arbitrary_branch' ? [{ kind: 'valueInput', name: 'COND' }] : [{ kind: 'field', name: 'NUM' }],
      }); fail('accepted duplicate input');
    } catch (error) {
      const wire = serializeAbsFailure(error);
      expect(wire.code).toBe('ABS_SYNTAX_INVALID');
      expect(wire.diagnostic).toEqual(jasmine.objectContaining({ blockType: 'arbitrary_branch', field: 'COND', reason: 'duplicate-input' }));
      expect(wire.diagnostic!.hint).toContain('not both');
    }
  });
  it('preserves protected-root errors through the actual tool boundary without leaking private IDs', async () => {
    const sync = { exportGeneration: async () => assertAbsProtectedBlocks(
      { blocks: { blocks: [{ type: 'arduino_global', id: 'private-root', deletable: false }] } },
      { blocks: { blocks: [] } }) };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_projection', {
      version: 2, requestId: 'protected-root-request', expectedAbiHash: 'sha256:' + 'a'.repeat(64),
    }, 'arduino_setup()');
    expect(result.ok).toBeFalse();
    expect(result.code).toBe('ABS_PROTECTED_BLOCK_MISSING');
    expect(result.diagnostic.blockType).toBe('arduino_global');
    expect(result.recovery).toContain('Keep the protected arduino_global');
    expect(JSON.stringify(result)).not.toContain('private-root');
    expect(result.receipt).toBeUndefined();
  });
  it('identifies the protected root across the wire without exposing private IDs', () => {
    const root = { type: 'arduino_global', id: 'private-root', deletable: false };
    for (const [blocks, code] of [
      [[], 'ABS_PROTECTED_BLOCK_MISSING'],
      [[{ ...root, type: 'arduino_loop' }], 'ABS_PROTECTED_BLOCK_TYPE_CHANGED'],
      [[{ ...root, deletable: true }], 'ABS_PROTECTED_BLOCK_UNLOCK'],
    ] as const) {
      try {
        assertAbsProtectedBlocks({ blocks: { blocks: [root] } }, { blocks: { blocks: [...blocks] } });
        fail('accepted protected root mutation');
      } catch (error) {
        const wire = serializeAbsFailure(error);
        expect(wire.code).toBe(code);
        expect(wire.diagnostic!.blockType).toBe('arduino_global');
        expect(wire.diagnostic!.hint).toContain('including empty roots');
        expect(JSON.stringify(wire)).not.toContain('private-root');
      }
    }
    expect(() => assertAbsProtectedBlocks({ blocks: { blocks: [root] } }, { blocks: { blocks: [root] } })).not.toThrow();
  });
  it('preserves the identity reason and specific recovery guidance through the wire boundary', async () => {
    const sync = { exportGeneration: async () => {
      throw new AbsSyncError('ABS_IDENTITY_AMBIGUOUS', 'Identity is ambiguous', { start: 4, end: 8 }, [], {
        blockType: 'step', reason: 'indistinguishable-relocation', received: 2,
        hint: 'Preserve call tokens; changing literals or querying block_info cannot repair identity.',
        identity: { evidence: 'tracked', batches: 1, edits: 2, baselineCount: 1, candidateCount: 2,
          baselineRanges: [{ start: 5, end: 9 }], candidateRanges: [{ start: 4, end: 8 }, { start: 11, end: 15 }],
          replacedBaselineRanges: [{ start: 5, end: 9 }] },
      });
    } };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_projection', {
      version: 2, requestId: 'identity-diagnostic-request', expectedAbiHash: 'sha256:' + 'a'.repeat(64),
    }, 'abc\nstep()');
    expect(result.ok).toBeFalse(); expect(result.receipt).toBeUndefined();
    expect(result.diagnostic.reason).toBe('indistinguishable-relocation');
    expect(result.recovery).toBe(result.diagnostic.hint);
    expect(result.location).toEqual({ line: 2, column: 1 });
    expect(result.diagnostic.identity.baselineRanges).toEqual([{ start: 5, end: 9 }]);
    expect(result.diagnostic.identity.candidateCount).toBe(2);
  });
  it('preserves the same diagnostic in the pure existing-block reconciliation path', async () => {
    const baseline = await createAbsProjection({ blocks: { blocks: [{ type: 'device', id: 'b', fields: { PIN: 'D0' } }] } }, {
      contracts: { fields: { b: { PIN: { type: 'field_dropdown', options: [['D0', 'D0'], ['D3', 'D3']] } } } },
      document: null, generation: 'g1', baselineRef: 'base', savedAbiHash: null, scope: { projectKey: 'test', pageId: 'main' },
    });
    const source = baseline.abs.replace('PIN=D0', 'PIN=3');
    expect(source).not.toBe(baseline.abs);
    await expectAsync(reconcileAbs(baseline, source)).toBeRejectedWith(jasmine.objectContaining({
      code: 'ABS_FIELD_OPTION_INVALID', diagnostic: jasmine.objectContaining({
        blockType: 'device', field: 'PIN', received: 3, allowedValues: ['D0', 'D3'],
      }),
    }));
    expect(baseline.workspace.blocks.blocks[0].fields!['PIN']).toBe('D0');
  });
  it('returns a failed tool result with line/column and no success receipt', async () => {
    const sync = { exportGeneration: async () => {
      throw new AbsSyncError('ABS_FIELD_OPTION_INVALID', 'Wrong pin', { start: 4, end: 5 }, [],
        { blockType: 'device', field: 'PIN', received: 3, allowedValues: ['D3'] });
    } };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_projection', {
      version: 2, requestId: 'test-diagnostic-request', expectedAbiHash: 'sha256:' + 'a'.repeat(64),
    }, 'abc\n3');
    expect(result.ok).toBeFalse(); expect(result.code).toBe('ABS_FIELD_OPTION_INVALID');
    expect(result.location).toEqual({ line: 2, column: 1 });
    expect(result.diagnostic.allowedValues).toEqual(['D3']); expect(result.receipt).toBeUndefined();
  });
  it('retains typed error data across a data-only boundary without unknown properties', () => {
    const error = new AbsSyncError('ABS_FIELD_OPTION_INVALID', 'Wrong pin', { start: 2, end: 3 }, ['private-id'],
      { blockType: 'device', field: 'PIN', received: 3, allowedValues: ['D0', 'D3'] });
    const wire = serializeAbsFailure(error), restored = restoreAbsFailure(JSON.parse(JSON.stringify(wire)));
    expect(restored.code).toBe(error.code);
    expect(restored.diagnostic).toEqual(error.diagnostic);
    expect(restored.range).toEqual(error.range);
    expect(JSON.stringify(wire)).not.toContain('private-id');
    expect(restored instanceof Error).toBeTrue();
  });

  it('bounds third-party payloads and rejects injected properties/invalid ranges', () => {
    const wire = serializeAbsFailure({ code: 'library-code', message: 'x'.repeat(5000), range: { start: -1, end: 3 },
      diagnostic: { field: 'x'.repeat(500), allowedValues: Array(200).fill('a'), expectedTypes: [1, 'T'],
        received: { huge: 'payload' }, receipt: 'fake' }, receipt: 'fake' });
    expect(wire.code).toBe('ABS_GENERATION_FAILED'); expect(wire.message.length).toBe(2000);
    expect(wire.range).toBeUndefined(); expect(wire.diagnostic!.field!.length).toBe(256);
    expect(wire.diagnostic!.allowedValues!.length).toBe(64); expect(wire.diagnostic!.truncated).toBeTrue();
    expect(wire.diagnostic!.expectedTypes).toEqual(['T']); expect(wire.diagnostic!.received).toBeUndefined();
    expect(JSON.stringify(wire)).not.toContain('fake');
  });

  it('bounds identity evidence and strips source, IDs and malformed ranges', () => {
    const identity = { evidence: 'tracked', batches: 1, edits: 2, baselineCount: 100, candidateCount: 100,
      baselineRanges: Array(100).fill({ start: 1, end: 5, id: 'private-id' }),
      candidateRanges: [{ start: -1, end: 0 }, { start: 5, end: 2 }, { start: 2, end: 6, text: 'private-source' }],
      replacedBaselineRanges: [], source: 'private-source' };
    const wire = serializeAbsFailure({ diagnostic: { identity } });
    expect(wire.diagnostic!.identity!.baselineRanges.length).toBe(8);
    expect(wire.diagnostic!.identity!.baselineCount).toBe(100);
    expect(wire.diagnostic!.identity!.candidateRanges).toEqual([{ start: 2, end: 6 }]);
    expect(wire.diagnostic!.truncated).toBeTrue();
    expect(JSON.stringify(wire)).not.toContain('private-');
    for (const value of [{ ...identity, evidence: 'forged' }, { ...identity, batches: -1 }, { ...identity, edits: NaN }]) {
      expect(serializeAbsFailure({ diagnostic: { identity: value } }).diagnostic).toBeUndefined();
    }
  });

  it('gives exact pin choices without converting numeric pins to board aliases', () => {
    try { resolveAbsFieldValue(readAbsFieldToken('3'), { type: 'field_dropdown', options: [['pin 3', 'D3']] }); fail('accepted'); }
    catch (error) {
      const wire = serializeAbsFailure(error);
      expect(wire.code).toBe('ABS_FIELD_OPTION_INVALID');
      expect(wire.diagnostic).toEqual(jasmine.objectContaining({ received: 3, allowedValues: ['D3'] }));
    }
  });

  it('distinguishes missing models from incompatible same-name types without creating anything', () => {
    const contract = { kind: 'variable' as const, storage: 'id' as const, allowedTypes: ['SENSOR'] };
    const models = [{ id: 'id', name: 'sensor', type: '' }];
    const symbols = new AbsSymbols({ blocks: { blocks: [] }, variables: models }, null, { fields: {} });
    for (const [name, code, actualTypes] of [['sensor', 'ABS_SYMBOL_TYPE_MISMATCH', ['']], ['missing', 'ABS_SYMBOL_MISSING', []]] as const) {
      try { symbols.resolve(readAbsFieldToken('$' + name), contract); fail('accepted'); }
      catch (error) {
        const wire = serializeAbsFailure(error);
        expect(wire.code).toBe(code);
        expect(wire.diagnostic).toEqual(jasmine.objectContaining({ modelName: name, expectedTypes: ['SENSOR'], actualTypes }));
        expect(wire.diagnostic!.hint).not.toMatch(/createVariables|registerVariableToBlockly/);
        expect(wire.diagnostic!.hint).toContain(name === 'missing' ? 'README' : 'distinct name');
      }
    }
    expect(models).toEqual([{ id: 'id', name: 'sensor', type: '' }]);
  });

  it('bounds batched conflicts and keeps only actionable names/types, not opaque callback data', () => {
    const wire = serializeAbsFailure({ diagnostic: { conflicts: Array(20).fill({ modelName: 'sensor', availableName: 'sensor_2',
      actualTypes: ['OLD', { bad: true }], expectedTypes: ['NEW'], privateState: 'secret' }) } });
    expect(wire.diagnostic!.conflicts!.length).toBe(16);
    expect(wire.diagnostic!.conflicts![0]).toEqual({ modelName: 'sensor', availableName: 'sensor_2', actualTypes: ['OLD'], expectedTypes: ['NEW'] });
    expect(wire.diagnostic!.truncated).toBeTrue();
    expect(JSON.stringify(wire)).not.toContain('secret');
  });
});
