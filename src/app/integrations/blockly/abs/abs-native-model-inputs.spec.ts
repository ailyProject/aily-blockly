import { prepareAbsNativeModelInputs } from './abs-native-model-inputs';
import { readAbsSyntax } from './abs-syntax';
import { compileAbsDeclarativeContract } from './abs-declarative-contracts';
import type { AbsAbiWorkspace } from './abs-state';

describe('native declaration bootstrap inputs', () => {
  const shape = compileAbsDeclarativeContract({ type: 'storage', previousStatement: null, nextStatement: null,
    args0: [{ type: 'field_input', name: 'NAME' }, { type: 'input_value', name: 'VALUE' },
      { type: 'field_dropdown', name: 'TYPE', options: [['int', 'int']] }] })!;
  const options = { argumentOrder: type => type === 'storage' ? shape.argumentOrder : undefined,
    declaration: type => type === 'storage' ? { nameField: 'NAME', nativeType: '', owner: { type: 'global', input: 'BODY' } } : undefined };
  const prepare = (source: string, workspace: AbsAbiWorkspace = { blocks: { blocks: [] } }, extra = {}) => {
    const raw = readAbsSyntax('# ABS Schema: 2\n' + source), before = structuredClone(raw);
    prepareAbsNativeModelInputs(raw, workspace, { ...options, ...extra }, 'bootstrap-request-0001');
    expect(raw).toEqual(before);
    return workspace['variables'];
  };

  it('uses declaration argument order and leaves an unknown initializer for full native binding', () => {
    expect(prepare('global()\n    storage("counter", unknown_shape(B, 7), int)')).toEqual([
      { id: 'abs-variable:bootstrap-request-0001:0', name: 'counter', type: '' },
    ]);
  });
  it('shares named argument rules, traverses nested calls and does not infer names from references', () => {
    expect(prepare('unknown_root(storage(TYPE=int, VALUE=other_unknown(1), NAME="counter"))\nuse($typo)')).toEqual([
      { id: 'abs-variable:bootstrap-request-0001:0', name: 'counter', type: '' },
    ]);
    expect(prepare('storage($counter, null, int)\nuse($counter)')).toBeUndefined();
  });
  it('requires attestation and skips disabled declarations and owners', () => {
    expect(prepare('storage("counter", null, int)', undefined, { declaration: undefined })).toBeUndefined();
    expect(prepare('storage("counter", null, int) @disabled')).toBeUndefined();
    expect(prepare('global() @disabled\n    storage("counter", null, int)')).toBeUndefined();
  });
  it('reuses existing inputs without altering IDs/types/opaque state; authoritative conflicts are not resolved here', () => {
    const variables = [{ id: 'existing', name: 'Counter', type: 'typed', opaque: true }];
    expect(prepare('storage("counter", null, int)', { blocks: { blocks: [] }, variables })).toBe(variables);
    expect(prepare('storage("counter", null, int)\nstorage("counter", null, int)')).toEqual([
      { id: 'abs-variable:bootstrap-request-0001:0', name: 'counter', type: '' },
    ]);
  });
  it('still rejects duplicate arguments and wrong field/value syntax via the shared binder', () => {
    expect(() => prepare('storage("counter", NAME="other")')).toThrow();
    expect(() => prepare('storage(other_unknown(), null, int)')).toThrow();
  });
});
