import { adaptLegacyDhtRuntimeState } from '../../../editors/blockly-editor/services/blockly-legacy-dht-runtime';

describe('saved DHT variable graph against the installed library shape', () => {
  const types = ['dht_init', 'dht_read_temperature', 'dht_read_humidity', 'dht_read_success'];
  const definitions = (fields: string[]) => ({ get: (type: string) => types.includes(type) ? {
    args0: fields.map(name => ({ type: 'field_dropdown', name })),
  } : undefined });
  const source = () => ({
    variables: [{ id: 'sensor-id', name: 'dht', type: 'DHT' }],
    blocks: { blocks: [
      { type: 'dht_init', id: 'init', fields: { VAR: 'dht', TYPE: 'DHT11', PIN: '2' } },
      { type: 'dht_read_temperature', id: 'read', fields: { VAR: { id: 'sensor-id' } } },
    ] },
  });

  it('uses the saved sensor type and pin for the old installed TYPE/PIN blocks without changing the ABI', () => {
    const input = source(), original = JSON.stringify(input);
    const result = adaptLegacyDhtRuntimeState(input, definitions(['TYPE', 'PIN']));
    expect(result).not.toBe(input);
    expect(result.blocks.blocks[0].fields as any).toEqual({ TYPE: 'DHT11', PIN: '2' });
    expect(result.blocks.blocks[1].fields as any).toEqual({ TYPE: 'DHT11', PIN: '2' });
    expect(JSON.stringify(input)).toBe(original);
  });

  it('retains the variable graph when the installed library supports it', () => {
    const input = source();
    expect(adaptLegacyDhtRuntimeState(input, definitions(['VAR', 'TYPE', 'PIN']))).toBe(input);
  });

  it('leaves ambiguous or unresolved sensors untouched', () => {
    const duplicate = source();
    duplicate.blocks.blocks.push({ type: 'dht_init', id: 'other', fields: { VAR: 'dht', TYPE: 'DHT22', PIN: '4' } } as any);
    expect(adaptLegacyDhtRuntimeState(duplicate, definitions(['TYPE', 'PIN']))).toBe(duplicate);
    const unresolved = source();
    (unresolved.blocks.blocks[1].fields.VAR as { id: string }).id = 'missing';
    expect(adaptLegacyDhtRuntimeState(unresolved, definitions(['TYPE', 'PIN']))).toBe(unresolved);
  });
});
