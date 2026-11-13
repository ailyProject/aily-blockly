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
  it('normalizes deeply connected blocks without the platform native stringify stack limit', () => {
    let block: any = { type: 'tail', id: 'tail', optional: undefined };
    for (let i = 0; i < 6000; i++) block = { type: 'statement', id: String(i), next: { block } };
    const result = normalizeAbsSerializedWorkspace({ blocks: { blocks: [block] } });
    let count = 0, current = result.blocks.blocks[0];
    while (current) { count++; if (!current.next) expect(Object.hasOwn(current, 'optional')).toBeFalse(); current = current.next?.block; }
    expect(count).toBe(6001);
  });

});
