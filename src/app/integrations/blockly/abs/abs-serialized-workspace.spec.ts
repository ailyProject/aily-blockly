import { normalizeAbsSerializedWorkspace } from './abs-serialized-workspace';

describe('Blockly serialized workspace JSON boundary', () => {
  it('omits optional undefined members in arbitrary fields and serializer state without mutating the source', () => {
    const field = { optionalName: undefined, frames: [1, 2], nested: { unused: undefined, keep: false } };
    const source = { blocks: { blocks: [{ type: 'custom', id: 'one', fields: { arbitraryField: field } }] }, extra: { optional: undefined } };
    expect(normalizeAbsSerializedWorkspace(source)).toEqual(JSON.parse(JSON.stringify(source)));
    expect(Object.prototype.hasOwnProperty.call(field, 'optionalName')).toBeTrue();
  });
  it('does not silently discard non-JSON payloads or convert nonfinite numbers to null', () => {
    for (const value of [() => 'data', Symbol('data'), BigInt(1), NaN, Infinity]) {
      expect(() => normalizeAbsSerializedWorkspace({ fields: { value } })).toThrowError(/non-JSON/);
    }
  });
});
