import { nativeSemanticChange } from '../../../editors/blockly-editor/services/blockly-native-semantic-diagnostic';
import { NativeUiTasks } from '../../../editors/blockly-editor/services/blockly-native-ui-tasks';
import { serializeAbsFailure, restoreAbsFailure } from './abs-diagnostics';
import { AbsGenerationToolsService } from './abs-generation-tools.service';

describe('native semantic failure context', () => {
  const snapshot = (options: string[]) => JSON.stringify({ state: { blocks: { blocks: [] } }, shapes: [
    { id: 'serial-consumer', type: 'serial_read', inputs: [{ fields: [{ name: 'SERIAL', type: 'field_dropdown', options }] }] },
  ] });
  it('reports stable block/field identities and changed keys, not a positional index alone', () => {
    const failure = restoreAbsFailure(serializeAbsFailure(nativeSemanticChange(snapshot(['Serial', 'Serial1']),
      snapshot(['Serial', 'Serial1', 'hmiSerial']), 'ui')));
    expect(failure.code).toBe('ABS_NATIVE_UI_CONTRACT_CHANGED');
    expect(failure.diagnostic).toEqual(jasmine.objectContaining({ phase: 'ui', blockId: 'serial-consumer',
      blockType: 'serial_read', field: 'SERIAL', path: '/shapes/0/inputs/0/fields/0/options/2',
      previousAllowedValues: ['Serial', 'Serial1'], allowedValues: ['Serial', 'Serial1', 'hmiSerial'], received: 'hmiSerial' }));
    expect(failure.diagnostic!.hint).toContain('Unchanged chunk, reload or apply cannot repair');
  });
  it('locates state-field changes with escaped names without dumping surrounding state', () => {
    const state = (value: number) => JSON.stringify({ state: { blocks: { blocks: [
      { id: 'owner', type: 'arbitrary_type', fields: { 'A/B~C': value }, extraState: { private: 'not-in-diagnostic' } },
    ] } }, shapes: [] });
    const failure = nativeSemanticChange(state(1), state(2), 'initialization');
    expect(failure.diagnostic).toEqual(jasmine.objectContaining({ blockId: 'owner', blockType: 'arbitrary_type',
      field: 'A/B~C', path: '/state/blocks/blocks/0/fields/A~1B~0C', expected: 1, received: 2 }));
    expect(JSON.stringify(serializeAbsFailure(failure))).not.toContain('not-in-diagnostic');
  });
  it('retains known before/after values for removed constraints and identifies new structures', () => {
    const failure = nativeSemanticChange('{"state":{"blocks":{"blocks":[]}}}',
      '{"state":{"blocks":{"blocks":[{"id":"new","type":"unexpected"}]}}}', 'initialization');
    expect(failure.diagnostic).toEqual(jasmine.objectContaining({ blockId: 'new', blockType: 'unexpected' }));
    expect(failure.diagnostic!.received).toBeUndefined();
  });
  it('bounds context before and after the wire sanitizer', () => {
    const before = snapshot(Array.from({ length: 100 }, (_, i) => i + '-'.repeat(300)));
    const failure = nativeSemanticChange(before, snapshot(['short']), 'ui');
    expect(failure.diagnostic!.previousAllowedValues!.length).toBe(64);
    expect(String(failure.diagnostic!.previousAllowedValues![0]).length).toBe(256);
    expect(failure.diagnostic!.truncated).toBeTrue();
    const wire = serializeAbsFailure({ ...failure, diagnostic: { ...failure.diagnostic,
      expected: 'x'.repeat(400), path: '/' + 'p'.repeat(600), secret: 'discard', application: 'COMMITTED' } });
    expect(wire.diagnostic!.expected!.toString().length).toBe(256);
    expect(wire.diagnostic!.path!.length).toBe(512);
    expect(JSON.stringify(wire)).not.toMatch(/discard|COMMITTED/);
  });
  it('does not expose arbitrary error objects as primitive values or accepted options', () => {
    const result = serializeAbsFailure({ diagnostic: { blockId: 'safe', phase: 'ui', path: 'not-a-pointer',
      expected: { private: true }, previousAllowedValues: [{ private: true }, 'A'], allowedValues: ['B', Infinity] } });
    expect(result.diagnostic).toEqual({ blockId: 'safe', phase: 'ui', previousAllowedValues: ['A'], allowedValues: ['B'] });
  });
  it('keeps a typed failure even if diagnostic readback itself cannot parse a snapshot', () => {
    const failure = nativeSemanticChange('broken', 'also broken', 'ui');
    expect(failure.code).toBe('ABS_NATIVE_UI_CONTRACT_CHANGED');
    expect(failure.diagnostic!.path).toBe('/');
  });
  it('preserves phase through the queue and actual validation tool without applying or minting a receipt', async () => {
    let after = false, applies = 0;
    const tasks = new NativeUiTasks(); tasks.set(() => { after = true; });
    const sync = { validateGeneration: async () => tasks.drain(() => snapshot(after ? ['B'] : ['A']), 'initialization'),
      applyGeneration: async () => { applies++; } };
    const result: any = await new AbsGenerationToolsService(sync as any).execute('abs_validate', { version: 2,
      requestId: 'native-contract-diagnostic', base: { generation: 'baseline-generation',
        scope: { projectKey: 'isolated-project', pageId: 'main' }, abiHash: 'sha256:' + 'a'.repeat(64),
        absHash: 'sha256:' + 'b'.repeat(64), mapHash: 'sha256:' + 'c'.repeat(64) },
      candidate: { hash: 'sha256:' + 'd'.repeat(64), bytes: 9 } }, 'candidate');
    expect(result.code).toBe('ABS_NATIVE_UI_CONTRACT_CHANGED');
    expect(result.diagnostic.phase).toBe('initialization');
    expect(result.diagnostic.field).toBe('SERIAL');
    expect(result.receipt).toBeUndefined(); expect(applies).toBe(0);
    expect(result.application).toBeUndefined(); expect(result.publication).toBeUndefined();
  });
});
