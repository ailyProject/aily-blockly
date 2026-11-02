import { assertAbsNativeModelDeclarations } from './abs-native-model-declarations';
import { serializeAbsFailure } from './abs-diagnostics';

describe('native declaration diagnostics', () => {
  const declaration = { start: 17, blockType: 'initialize', id: 'model-id', name: 'sensor', type: 'Sensor' };
  const reject = (value: unknown) => {
    try { assertAbsNativeModelDeclarations(value); fail('Expected an invalid declaration'); }
    catch (error) { return serializeAbsFailure(error); }
    return undefined!;
  };

  it('distinguishes malformed values without returning their contents', () => {
    for (const [change, field, reason, actualType] of [
      [{ name: null }, 'name', 'invalid-type', 'null'],
      [{ type: 42 }, 'type', 'invalid-type', 'number'],
      [{ name: '' }, 'name', 'empty-text', undefined],
      [{ name: ' sensor' }, 'name', 'surrounding-whitespace', undefined],
      [{ type: 'Sensor\n' }, 'type', 'control-character', undefined],
    ] as const) {
      const error = reject([{ ...declaration, ...change }]);
      expect(error.code).toBe('ABS_MODEL_DECLARATION_INVALID');
      expect(error.range).toEqual({ start: 17, end: 27 });
      expect(error.diagnostic).toEqual(jasmine.objectContaining({ blockType: 'initialize', phase: 'model-declaration', field, reason }));
      if (actualType) expect(error.diagnostic?.actualTypes).toEqual([actualType]);
    }
  });

  it('reports only the actual and allowed length for oversized registration text', () => {
    const error = reject([{ ...declaration, name: 'private-payload'.repeat(10000) }]);
    expect(error.diagnostic).toEqual(jasmine.objectContaining({ field: 'name', reason: 'text-limit', received: 150000, expected: 256 }));
    expect(JSON.stringify(error)).not.toContain('private-payload');
    expect(JSON.stringify(error).length).toBeLessThan(1200);
  });

  it('identifies duplicate identities separately from duplicate typed declarations', () => {
    expect(reject([declaration, { ...declaration, name: 'other' }]).diagnostic?.reason).toBe('duplicate-identity');
    expect(reject([declaration, { ...declaration, id: 'different' }]).diagnostic?.reason).toBe('duplicate-model');
    expect(() => assertAbsNativeModelDeclarations([declaration, { ...declaration, id: 'function', type: 'FUNC' }])).not.toThrow();
  });

  it('distinguishes invalid containers, empty evidence, offsets and capacity without accepting them', () => {
    expect(reject({}).diagnostic?.reason).toBe('invalid-container');
    expect(reject([]).diagnostic?.reason).toBe('empty-declarations');
    expect(reject([{ ...declaration, start: -1 }]).diagnostic?.reason).toBe('invalid-offset');
    const error = reject(Array(513).fill(declaration));
    expect(error.diagnostic).toEqual(jasmine.objectContaining({ reason: 'declaration-limit', received: 513, expected: 512 }));
    expect(() => assertAbsNativeModelDeclarations(undefined)).not.toThrow();
  });
});
